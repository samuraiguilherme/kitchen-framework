import { Ajv } from "ajv";
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "./process.ts";
import type { ProcessResult } from "./process.ts";
import { providerProgress } from "./provider-progress.ts";
import { promptSections } from "./metrics.ts";
import { summarizeTokenEvents } from "./token-budget.ts";
import { resolveProviderExecutable } from "./provider-executable.ts";
import {
  checkDeepSeekModel,
  DeepSeekContractError,
  deepseekFinalAnswer,
  parseDeepSeekOutput,
  prepareDeepSeek,
} from "./deepseek.ts";
import type {
  AuthorOutput,
  Provider,
  ProviderName,
  ProviderRequest,
  ReviewOutput,
  RoleConfig,
  Station,
} from "./types.ts";

const str = { type: "string" };
const strings = { type: "array", items: str };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const findingSchema = object({
  id: str,
  rule: str,
  blocking: { type: "boolean" },
  evidence: str,
  consequence: str,
  resolution: str,
});
export const checkSchema = object({
  id: {
    type: "string",
    description:
      "Unique lowercase kebab-case check ID, e.g. backend-purchases or manual-browser. Use the same ID in document references.",
  },
  profile: str,
  files: strings,
  acIds: strings,
  required: { type: "boolean" },
  expectation: { enum: ["red", "green"], type: "string" },
});
export const authorSchema = object({
  summary: str,
  questions: { type: "array", items: object({ id: str, text: str }) },
  document: { type: ["string", "null"] },
  files: {
    type: "array",
    items: object({
      path: str,
      action: { type: "string", enum: ["write", "delete"] },
      content: { type: ["string", "null"] },
      kind: {
        type: "string",
        enum: ["test", "scaffold", "implementation", "support"],
      },
    }),
  },
  allowedPaths: strings,
  unitTestFiles: strings,
  scaffoldFiles: strings,
  checks: { type: "array", items: checkSchema },
});
const emptyAuthorArrays = Object.fromEntries(
  ["files", "allowedPaths", "unitTestFiles", "scaffoldFiles", "checks"].map(
    (key) => [key, { type: "array", items: str, maxItems: 0 }],
  ),
);
const documentStructuredSchema = object({
  ...authorSchema.properties,
  document: { anyOf: [{ type: "string", pattern: "\\S" }, { type: "null" }] },
  files: { type: "array", items: str, maxItems: 0 },
});
const documentAlternatives = [
  {
    properties: {
      questions: { type: "array", minItems: 1 },
      document: { type: "null" },
      ...emptyAuthorArrays,
    },
  },
  {
    properties: {
      questions: { type: "array", maxItems: 0 },
      document: { type: "string", pattern: "\\S" },
    },
  },
];
const documentAuthorSchema = {
  ...documentStructuredSchema,
  anyOf: documentAlternatives,
};
const intentStructuredSchema = object({
  ...documentStructuredSchema.properties,
  ...emptyAuthorArrays,
});
export const intentAuthorSchema = {
  ...intentStructuredSchema,
  anyOf: documentAlternatives,
};
const documentStations: readonly Station[] = ["intent", "spec", "plan", "test-plan"];
export function authorSchemaForStation(station?: Station, provider?: ProviderName) {
  // Hosted transports prohibit a root anyOf. Restrict their fields and enforce
  // the questions/document union locally with the full station validator.
  const hosted = provider === "codex" || provider === "claude";
  if (station === "intent")
    return hosted ? intentStructuredSchema : intentAuthorSchema;
  if (station && documentStations.includes(station))
    return hosted ? documentStructuredSchema : documentAuthorSchema;
  return authorSchema;
}
export const reviewSchema = object({
  summary: str,
  findings: { type: "array", items: findingSchema },
});
export const discoverySchema = object({
  summary: str,
  evidence: {
    type: "array",
    items: object({
      path: str,
      line: { type: "integer", minimum: 1 },
      hash: str,
    }),
  },
  unresolved: strings,
});
const ajv = new Ajv({ allErrors: true });
const authorValidator = ajv.compile(authorSchema);
const intentAuthorValidator = ajv.compile(intentAuthorSchema);
const documentAuthorValidator = ajv.compile(documentAuthorSchema);
const reviewValidator = ajv.compile(reviewSchema);
const discoveryValidator = ajv.compile(discoverySchema);
export function validateDiscoveryOutput(value: unknown) {
  if (!discoveryValidator(value))
    throw new Error(
      `Invalid discovery output: ${ajv.errorsText(discoveryValidator.errors)}`,
    );
  return value as unknown as import("./types.ts").DiscoveryResult;
}
export function validateAuthorOutput(
  value: unknown,
  station?: Station,
): AuthorOutput {
  const documentStation = station !== undefined && documentStations.includes(station);
  const validator = station === "intent" ? intentAuthorValidator
    : documentStation ? documentAuthorValidator : authorValidator;
  if (!validator(value))
    throw new Error(
      `Invalid ${documentStation ? `${station} author` : "author"} output: ${ajv.errorsText(validator.errors)}`,
    );
  return value as unknown as AuthorOutput;
}
export function validateReviewOutput(value: unknown): ReviewOutput {
  if (!reviewValidator(value))
    throw new Error(
      `Invalid review output: ${ajv.errorsText(reviewValidator.errors)}`,
    );
  const output = value as unknown as ReviewOutput;
  if (
    new Set(output.findings.map((f) => f.id)).size !== output.findings.length ||
    output.findings.some(
      (f) => !f.id.trim() || !f.evidence.trim() || !f.resolution.trim(),
    )
  )
    throw new Error(
      "Review findings require unique IDs, evidence, and resolutions.",
    );
  return output;
}
export function parseProviderOutput(
  provider: ProviderName,
  raw: string,
): unknown {
  if (provider === "deepseek") return parseDeepSeekOutput(raw);
  const result = JSON.parse(raw);
  if (provider === "codex") return result;
  if (
    result.is_error ||
    result.permission_denials?.length ||
    !result.structured_output
  )
    throw new Error(
      `Claude failed or denied a required tool: ${errorMessage(result.errors ?? result.result ?? "missing structured output; inspect local transcript")}`,
    );
  return result.structured_output;
}
export function providerInvocation(
  provider: ProviderName,
  schema: string,
  answerPath: string,
  _role: "author" | "review",
  model?: string,
  executable?: string,
  windowsSandbox?: RoleConfig["windowsSandbox"],
): { command: string; args: string[] } {
  if (provider === "deepseek")
    throw new Error(
      "DeepSeek invocation requires an isolated configuration; use the CLI provider.",
    );
  const args =
    provider === "codex"
      ? [
          "exec",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--disable",
          "hooks",
          "--disable",
          "plugins",
          "--disable",
          "apps",
          "--disable",
          "multi_agent",
          "--disable",
          "browser_use",
          "--disable",
          "computer_use",
          "--disable",
          "image_generation",
          "-c",
          "mcp_servers={}",
          "-c",
          "notify=[]",
          "-c",
          'web_search="disabled"',
          "--json",
          "--output-schema",
          schema,
          "--output-last-message",
          answerPath,
          "-",
        ]
      : [
          "-p",
          "--safe-mode",
          "--settings",
          '{"disableAllHooks":true}',
          "--output-format",
          "json",
          "--json-schema",
          schema,
          "--permission-mode",
          "dontAsk",
          "--tools",
          "Read,Glob,Grep",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--no-session-persistence",
          "--disable-slash-commands",
        ];
  if (model) args.push("--model", model);
  if (provider === "codex" && windowsSandbox)
    args.push("-c", `windows.sandbox="${windowsSandbox}"`);
  return { command: resolveProviderExecutable(provider, executable), args };
}
function errorMessage(value: unknown): string {
  if (typeof value === "string") {
    try {
      return errorMessage(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(errorMessage).join("; ");
  if (value && typeof value === "object") {
    const error = value as Record<string, unknown>;
    const detail = error.error ?? error.message ?? error.result;
    return detail === undefined ? JSON.stringify(value) : errorMessage(detail);
  }
  return String(value);
}
function processError(provider: ProviderName, result: ProcessResult): string {
  let detail = "";
  if (provider === "codex" || provider === "deepseek") {
    for (const line of result.stdout.trim().split(/\r?\n/).reverse()) {
      try {
        const event = JSON.parse(line);
        if (event.type === "error" || event.type === "turn.failed") {
          detail = errorMessage(event.error ?? event.message);
          break;
        }
      } catch {
        // Some CLI failures emit plain text instead of JSONL.
      }
    }
  } else {
    try {
      const envelope = JSON.parse(result.stdout);
      if (envelope.is_error)
        detail = errorMessage(envelope.errors ?? envelope.result);
    } catch {
      // Fall back to the captured process output.
    }
  }
  return (
    detail ||
    result.stderr.trim() ||
    result.stdout.trim() ||
    `Exited with code ${result.code}`
  ).slice(-1500);
}
async function invokeProviderAttempt(
  request: ProviderRequest,
  probe = false,
  deadline = Date.now() + request.timeoutMs,
): Promise<unknown> {
  mkdirSync(request.runDir, { recursive: true });
  const authorOutputSchema = authorSchemaForStation(
    probe ? undefined : request.station,
    request.config.provider,
  );
  const schema =
    request.kind === "discovery"
      ? discoverySchema
      : request.role === "author"
        ? authorOutputSchema
        : reviewSchema;
  const schemaFile = path.join(request.runDir, `${request.role}-schema.json`);
  const answerFile = path.join(request.runDir, `${request.role}-answer.json`);
  writeFileSync(schemaFile, JSON.stringify(schema));
  const deepseek =
    request.config.provider === "deepseek"
      ? prepareDeepSeek(request, schema, probe)
      : undefined;
  const invocation =
    deepseek ??
    providerInvocation(
      request.config.provider,
      request.config.provider === "codex" ? schemaFile : JSON.stringify(schema),
      answerFile,
      request.role,
      request.config.model,
      request.config.executable,
      request.config.windowsSandbox,
    );
  if (probe && request.config.provider === "codex")
    invocation.args.push("--skip-git-repo-check");
  if (probe || request.station === "intent") {
    if (request.config.provider === "claude")
      invocation.args[invocation.args.indexOf("--tools") + 1] = "";
    else if (request.config.provider === "codex")
      invocation.args.push("--disable", "shell_tool", "--disable", "view_image");
  }
  const input = deepseek?.input ?? request.prompt;
  writeFileSync(path.join(request.runDir, `${request.role}-prompt.txt`), input);
  // stdin avoids PowerShell interpolation and Windows command-length limits for prompts.
  const progress = providerProgress(request, probe);
  if (
    invocation.command !==
    (request.config.executable ?? request.config.provider)
  )
    progress.report(`resolved executable: ${invocation.command}`);
  progress.report(
    `starting ${request.config.provider}; model=${request.config.model ?? "CLI default"}${request.config.provider === "codex" ? `; windowsSandbox=${request.config.windowsSandbox ?? "CLI default"}` : ""}; evidence=${request.runDir}`,
  );
  const heartbeat = setInterval(
    () => { progress.checkpoint(); progress.report("provider still running"); },
    15000,
  );
  let result: ProcessResult;
  let modelIdentity: Awaited<ReturnType<typeof checkDeepSeekModel>> | undefined;
  const startedAt = new Date().toISOString();
  const remainingTimeout = () => {
    request.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new DOMException("Provider deadline exceeded.", "TimeoutError");
    return remaining;
  };
  try {
    if (deepseek) {
      modelIdentity = await checkDeepSeekModel(
        request.config,
        Math.min(remainingTimeout(), 10000),
        request.signal,
      );
      progress.report(`local model available; digest=${modelIdentity.digest}`);
    }
    result = await runProcess({
      command: invocation.command,
      args: invocation.args,
      ...(deepseek ? { env: deepseek.env } : {}),
      cwd: request.cwd,
      input,
      timeoutMs: remainingTimeout(),
      signal: request.signal,
      onOutput: progress.capture,
    });
    const failureReason = result.failureReason ?? progress.finish();
    if (failureReason) result = { ...result, code: -1, failureReason };
  } catch (error) {
    result = {
      code: -1,
      stdout: "",
      stderr: "",
      cancelled: request.signal?.aborted === true,
      timedOut: error instanceof Error && error.name === "TimeoutError",
      failureReason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearInterval(heartbeat);
  }
  const metrics = progress.metrics();
  metrics.completedAt = new Date().toISOString();
  if (result.code !== 0)
    metrics.terminationReason = result.cancelled ? "cancelled" : result.timedOut ? "timed-out" : metrics.terminationReason ?? "failed";
  if (deepseek) {
    const events: Array<Record<string, unknown>> = [];
    try {
      const lines = createInterface({
        input: createReadStream(deepseek.measurementFile), crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        // Full projections remain on disk; aggregate only their measurements.
        delete event.request;
        events.push(event);
      }
    } catch {
      events.push({
        type: "failure", incompleteUsage: true,
        message: "Incomplete DSH token evidence; inspect raw token events.",
      });
    }
    metrics.tokens = {
      ...summarizeTokenEvents(events),
      kitchenPromptBytes: Buffer.byteLength(request.prompt),
      adapterInputBytes: Buffer.byteLength(input),
      adapterSections: promptSections(input),
    };
    if (!metrics.tokens.usageComplete) delete metrics.usage;
    if (metrics.tokens.failure)
      result = { ...result, code: -1, failureReason: metrics.tokens.failure };
    for (const warning of new Set(metrics.tokens.warnings))
      progress.report(warning);
  }
  const processEvidence = {
    ...result,
    provider: request.config.provider,
    model: request.config.model ?? null,
    windowsSandbox: request.config.windowsSandbox ?? null,
    executable: invocation.command,
    cwd: request.cwd,
    startedAt,
    finishedAt: new Date().toISOString(),
    metrics,
    validationError: undefined as string | undefined,
    ...(deepseek
      ? {
          deepseek: {
            ...request.config.dsh,
            ...modelIdentity,
            overlayFile: deepseek.overlayFile,
            overlayHash: deepseek.overlayHash,
            effectiveMaxTokens: deepseek.maxTokens,
            measurementFile: deepseek.measurementFile,
          },
        }
      : {}),
  };
  const saveProcess = () =>
    writeFileSync(
      path.join(request.runDir, `${request.role}-process.json`),
      JSON.stringify(processEvidence, null, 2),
    );
  progress.report(
    `process exited; code=${result.code}${result.failureReason ? `; ${result.failureReason}` : ""}`,
  );
  if (result.code !== 0) {
    saveProcess();
    request.onMetrics?.(metrics);
    throw new Error(
      `${request.config.provider} ${result.cancelled ? "cancelled" : result.timedOut ? "timed out" : "failed"}: ${result.failureReason ?? processError(request.config.provider, result)}`,
    );
  }
  try {
    const raw =
      request.config.provider === "codex"
        ? readFileSync(answerFile, "utf8")
        : result.stdout;
    // Stream/session/tool failures are terminal. Only a completed final answer
    // that fails JSON or output validation is eligible for regeneration.
    const final = deepseek
      ? deepseekFinalAnswer(raw, probe || request.station === "intent")
      : undefined;
    if (request.session?.id && final?.sessionId !== request.session.id)
      throw new Error("DSH resumed a different session; no candidate accepted.");
    let output: unknown;
    try {
      output = final
        ? JSON.parse(final.text)
        : parseProviderOutput(request.config.provider, raw);
      if (request.kind === "discovery") validateDiscoveryOutput(output);
      else if (request.role === "author")
        validateAuthorOutput(output, probe ? undefined : request.station);
      else validateReviewOutput(output);
    } catch (error) {
      if (final)
        throw new DeepSeekContractError(
          error instanceof Error ? error.message : String(error),
          final.sessionId,
          path.resolve(request.runDir, `${request.role}-events.jsonl`),
        );
      throw error;
    }
    if (deepseek) writeFileSync(answerFile, JSON.stringify(output, null, 2));
    if (final) request.onSession?.(final.sessionId);
    metrics.actionableOutputMs = metrics.durationMs;
    if (request.config.provider === "claude") {
      const envelope = JSON.parse(result.stdout);
      if (envelope.usage)
        metrics.usage = Object.fromEntries(
          Object.entries(envelope.usage).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        );
    }
    writeFileSync(
      path.join(request.runDir, `${request.role}-output.json`),
      JSON.stringify(output, null, 2),
    );
    return output;
  } catch (error) {
    processEvidence.validationError =
      error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    saveProcess();
    request.onMetrics?.(metrics);
  }
}
async function invokeProvider(
  request: ProviderRequest,
  probe = false,
): Promise<unknown> {
  const deadline = Date.now() + request.timeoutMs;
  try {
    return await invokeProviderAttempt(request, probe, deadline);
  } catch (error) {
    if (!(error instanceof DeepSeekContractError)) throw error;
    const remaining = deadline - Date.now();
    if (request.signal?.aborted || remaining <= 0) throw error;
    const runDir = path.join(request.runDir, "contract-retry");
    const attempts = {
      status: "regenerating",
      timeoutMs: request.timeoutMs,
      original: { runDir: path.resolve(request.runDir), error: error.message },
      retry: { runDir: path.resolve(runDir), error: undefined as string | undefined },
    };
    const saveAttempts = () =>
      writeFileSync(
        path.join(request.runDir, `${request.role}-attempts.json`),
        JSON.stringify(attempts, null, 2),
      );
    saveAttempts();
    request.onProgress?.(`DSH final answer violated JSON contract; regenerating once; session=${error.sessionId}; evidence=${error.evidencePath}`);
    try {
      const output = await invokeProviderAttempt({
        ...request,
        session: undefined,
        onSession: undefined,
        runDir,
        timeoutMs: Math.max(1, deadline - Date.now()),
        prompt: `${request.freshPrompt ?? request.prompt}\n\nKITCHEN CORRECTIVE REGENERATION (one attempt only)\nYour previous completed final answer violated the JSON/output contract: ${error.detail}\nRegenerate the answer to the original request using the supplied context and recorded human answers. Return exactly one complete JSON object matching the schema, without commentary or Markdown fences. All station boundaries still apply.`,
      }, probe, deadline);
      // Retain both raw attempts; expose only the validated candidate at the
      // usual output paths for existing consumers.
      for (const suffix of ["answer", "output"])
        writeFileSync(
          path.join(request.runDir, `${request.role}-${suffix}.json`),
          JSON.stringify(output, null, 2),
        );
      attempts.status = "completed";
      return output;
    } catch (retryError) {
      attempts.status = "failed";
      attempts.retry.error =
        retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(
        `${attempts.retry.error} (after one corrective regeneration; original failure: ${error.message})`,
        { cause: retryError },
      );
    } finally {
      saveAttempts();
    }
  }
}
export const cliProvider: Provider = async (request) => {
  const output = await invokeProvider(request);
  return request.kind === "discovery"
    ? validateDiscoveryOutput(output)
    : request.role === "author"
      ? validateAuthorOutput(output, request.station)
      : validateReviewOutput(output);
};
// Existing integrations can retain this name while migrating to local providers.
export const hostedProvider = cliProvider;

export type ProbeContract = "author" | "review" | "discovery";

export async function probeProvider(
  config: RoleConfig,
  runDir: string,
  timeoutMs: number,
  signal?: AbortSignal,
  contract: ProbeContract = "review",
): Promise<void> {
  // A child directory inside the repository still inherits its AGENTS/CLAUDE files.
  const cwd = mkdtempSync(path.join(tmpdir(), "kitchen-model-probe-"));
  const summary = "Kitchen model probe OK";
  const expected =
    contract === "author"
      ? {
          summary, questions: [], document: null, files: [], allowedPaths: [],
          unitTestFiles: [], scaffoldFiles: [], checks: [],
        }
      : contract === "discovery"
        ? { summary, evidence: [], unresolved: [] }
        : { summary, findings: [] };
  try {
    const output = await invokeProvider(
      {
        station: contract === "discovery" ? "plan" : "intent",
        role: contract === "review" ? "review" : "author",
        ...(contract === "discovery" ? { kind: "discovery" as const } : {}),
        config, cwd, runDir, timeoutMs, signal,
        prompt: `This is a model availability check. Do not use tools or read files. Return only the JSON object ${JSON.stringify(expected)}.`,
      },
      true,
    ) as Record<string, unknown>;
    if (
      Object.entries(expected).some(
        ([key, value]) => JSON.stringify(output[key]) !== JSON.stringify(value),
      )
    )
      throw new Error(
        "Unexpected model probe response; structured request not verified.",
      );
  } finally {
    try {
      rmdirSync(cwd);
    } catch {
      // Remove only this empty scratch directory; never recursively delete provider-created files.
    }
  }
}
