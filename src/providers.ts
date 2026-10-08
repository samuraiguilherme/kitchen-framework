import { Ajv } from "ajv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess } from "./process.ts";
import type {
  AuthorOutput,
  Provider,
  ProviderName,
  ReviewOutput,
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
  id: str,
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
const ajv = new Ajv({ allErrors: true });
const authorValidator = ajv.compile(authorSchema);
const reviewValidator = ajv.compile(reviewSchema);
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
  const result = JSON.parse(raw);
  if (provider === "codex") return result;
  if (
    result.is_error ||
    result.permission_denials?.length ||
    !result.structured_output
  )
    throw new Error(
      "Claude failed or denied a required tool; inspect local transcript.",
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
): { command: string; args: string[] } {
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
          "{}",
          "--no-session-persistence",
          "--disable-slash-commands",
        ];
  if (model) args.push("--model", model);
  return { command: executable ?? provider, args };
}
export const hostedProvider: Provider = async (request) => {
  mkdirSync(request.runDir, { recursive: true });
  const schema = request.role === "author" ? authorSchema : reviewSchema;
  const schemaFile = path.join(request.runDir, `${request.role}-schema.json`);
  const answerFile = path.join(request.runDir, `${request.role}-answer.json`);
  writeFileSync(schemaFile, JSON.stringify(schema));
  writeFileSync(
    path.join(request.runDir, `${request.role}-prompt.txt`),
    request.prompt,
  );
  const invocation = providerInvocation(
    request.config.provider,
    request.config.provider === "codex" ? schemaFile : JSON.stringify(schema),
    answerFile,
    request.role,
    request.config.model,
    request.config.executable,
  );
  // stdin avoids PowerShell interpolation and Windows command-length limits for prompts.
  const result = await runProcess({
    ...invocation,
    cwd: request.cwd,
    input: request.prompt,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
  });
  writeFileSync(
    path.join(request.runDir, `${request.role}-process.json`),
    JSON.stringify(result, null, 2),
  );
  if (result.code !== 0)
    throw new Error(
      `${request.config.provider} ${result.cancelled ? "cancelled" : result.timedOut ? "timed out" : "failed"}: ${result.stderr.slice(-1500)}`,
    );
  const raw =
    request.config.provider === "codex"
      ? readFileSync(answerFile, "utf8")
      : result.stdout;
  const output = parseProviderOutput(request.config.provider, raw);
  writeFileSync(
    path.join(request.runDir, `${request.role}-output.json`),
    JSON.stringify(output, null, 2),
  );
  return request.role === "author"
    ? validateAuthorOutput(output)
    : validateReviewOutput(output);
};
