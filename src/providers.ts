import { Ajv } from "ajv";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "./process.ts";
import type { ProcessResult } from "./process.ts";
import { providerProgress } from "./provider-progress.ts";
import { resolveProviderExecutable } from "./provider-executable.ts";
import {
  checkDeepSeekModel,
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
const reviewValidator = ajv.compile(reviewSchema);
const discoveryValidator = ajv.compile(discoverySchema);
export function validateDiscoveryOutput(value: unknown) {
  if (!discoveryValidator(value))
    throw new Error(
      `Invalid discovery output: ${ajv.errorsText(discoveryValidator.errors)}`,
    );
  return value as unknown as import("./types.ts").DiscoveryResult;
}
export function validateAuthorOutput(value: unknown): AuthorOutput {
  if (!authorValidator(value))
    throw new Error(
      `Invalid author output: ${ajv.errorsText(authorValidator.errors)}`,
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
async function invokeProvider(
  request: ProviderRequest,
  probe = false,
): Promise<unknown> {
  mkdirSync(request.runDir, { recursive: true });
  const schema =
    request.kind === "discovery"
      ? discoverySchema
      : request.role === "author"
        ? authorSchema
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
  if (probe) {
    if (request.config.provider === "codex")
      invocation.args.push("--skip-git-repo-check");
    else if (request.config.provider === "claude")
      invocation.args[invocation.args.indexOf("--tools") + 1] = "";
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
    () => progress.report("provider still running"),
    15000,
  );
  let result: ProcessResult;
  let modelIdentity: Awaited<ReturnType<typeof checkDeepSeekModel>> | undefined;
  const startedAt = new Date().toISOString();
  try {
    const started = Date.now();
    if (deepseek) {
      modelIdentity = await checkDeepSeekModel(
        request.config,
        Math.min(request.timeoutMs, 10000),
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
      timeoutMs: Math.max(1, request.timeoutMs - (Date.now() - started)),
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
    ...(deepseek
      ? {
          deepseek: {
            ...request.config.dsh,
            ...modelIdentity,
            overlayFile: deepseek.overlayFile,
            overlayHash: deepseek.overlayHash,
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
    const output =
      request.config.provider === "deepseek"
        ? parseDeepSeekOutput(raw, probe)
        : parseProviderOutput(request.config.provider, raw);
    if (request.kind === "discovery") validateDiscoveryOutput(output);
    else if (request.role === "author") validateAuthorOutput(output);
    else validateReviewOutput(output);
    if (deepseek) writeFileSync(answerFile, JSON.stringify(output, null, 2));
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
  } finally {
    saveProcess();
    request.onMetrics?.(metrics);
  }
}
export const cliProvider: Provider = async (request) => {
  const output = await invokeProvider(request);
  return request.kind === "discovery"
    ? validateDiscoveryOutput(output)
    : request.role === "author"
      ? validateAuthorOutput(output)
      : validateReviewOutput(output);
};
// Existing integrations can retain this name while migrating to local providers.
export const hostedProvider = cliProvider;

export async function probeProvider(
  config: RoleConfig,
  runDir: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  // A child directory inside the repository still inherits its AGENTS/CLAUDE files.
  const cwd = mkdtempSync(path.join(tmpdir(), "kitchen-model-probe-"));
  try {
    const output = validateReviewOutput(
      await invokeProvider(
        {
          station: "intent",
          role: "review",
          config,
          cwd,
          runDir,
          timeoutMs,
          signal,
          prompt:
            'This is a model availability check. Do not use tools or read files. Return only the JSON object {"summary":"Kitchen model probe OK","findings":[]}.',
        },
        true,
      ),
    );
    if (output.summary !== "Kitchen model probe OK" || output.findings.length)
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
