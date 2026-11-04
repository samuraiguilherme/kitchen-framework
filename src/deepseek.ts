import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { createHash } from "node:crypto";
import { resolveProviderExecutable } from "./provider-executable.ts";
import {
  generationLimit, tokenBudget, validateTokenPolicy,
} from "./token-budget.ts";
import type {
  Config,
  DeepSeekOptions,
  ProviderRequest,
  RoleConfig,
  Station,
} from "./types.ts";

const readTools = ["read", "glob", "grep"];
const eventTypes = new Set([
  "session",
  "status",
  "text",
  "thinking",
  "tool_call",
  "tool_result",
  "error",
  "final",
]);
const exactVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function normalizeDigest(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/.test(value))
    return;
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

export function validateDeepSeekConfig(config: RoleConfig): DeepSeekOptions {
  const options = config.dsh;
  let validURL = false;
  try {
    const url = new URL(options?.baseURL ?? "");
    validURL =
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      /^\/v1\/?$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {
    /* Invalid URLs are rejected below. */
  }
  if (
    config.provider !== "deepseek" ||
    typeof config.model !== "string" ||
    !config.model.trim() ||
    config.model.includes(":cloud") ||
    config.windowsSandbox !== undefined ||
    !options ||
    typeof options.version !== "string" ||
    !exactVersion.test(options.version) ||
    !validURL ||
    !Number.isSafeInteger(options.contextWindow) ||
    options.contextWindow < 1 ||
    !Number.isSafeInteger(options.maxTokens) ||
    options.maxTokens < 1 ||
    options.maxTokens >= options.contextWindow ||
    (options.expectedModelDigest !== undefined &&
      !normalizeDigest(options.expectedModelDigest))
  )
    throw new Error(
      "Invalid DeepSeek provider configuration: require an exact DSH version, explicit local model, loopback /v1 URL and positive context/output limits.",
    );
  if (options.tokenPolicy !== undefined)
    validateTokenPolicy(options.tokenPolicy, options);
  return options;
}

export function deepseekVersionArgs(config: RoleConfig): string[] {
  const options = validateDeepSeekConfig(config);
  return [
    "--yes",
    "--offline",
    `@deepseek-ai/dsh@${options.version}`,
    "--version",
  ];
}

export function deepseekSetupRole(): RoleConfig {
  return {
    provider: "deepseek",
    model: "kitchen-deepseek-r1:8b",
    dsh: {
      version: "0.2.2-alpha.3",
      baseURL: "http://127.0.0.1:11434/v1",
      contextWindow: 8192,
      maxTokens: 2048,
    },
  };
}

export async function readDeepSeekModels(
  config: RoleConfig,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const options = validateDeepSeekConfig(config);
  const response = await fetch(new URL("/api/tags", options.baseURL), {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Ollama model inventory failed: HTTP ${response.status}`);
  const body: unknown = await response.json();
  const models =
    body && typeof body === "object" && "models" in body
      ? body.models
      : undefined;
  if (!Array.isArray(models))
    throw new Error("Invalid Ollama model inventory.");
  return models as unknown[];
}

export function deepseekModelIdentity(config: RoleConfig, models: unknown[]) {
  const options = validateDeepSeekConfig(config);
  const model = models.find(
    (item): item is { name: string; digest?: unknown } =>
      item !== null &&
      typeof item === "object" &&
      "name" in item &&
      item.name === config.model,
  );
  if (!model)
    throw new Error(
      `Local model ${config.model} is not installed. Complete the Ollama setup first.`,
    );
  const digest = normalizeDigest(model.digest);
  if (!digest) throw new Error("Ollama did not report a valid model digest.");
  if (
    options.expectedModelDigest &&
    digest !== normalizeDigest(options.expectedModelDigest)
  )
    throw new Error(
      `Ollama model digest differs from the configured pin for ${config.model}.`,
    );
  return {
    model: config.model!,
    digest,
    baseURL: options.baseURL,
  };
}

export async function checkDeepSeekModel(
  config: RoleConfig,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  return deepseekModelIdentity(
    config,
    await readDeepSeekModels(config, timeoutMs, signal),
  );
}

export async function checkDeepSeekPins(
  config: Config,
  station: Station,
): Promise<void> {
  const pair = config.stations[station];
  const active = [
    ...(station === "publish" ? [] : [pair?.author ?? config.providers.author]),
    ...(pair?.reviewEnabled ? [pair.review ?? config.providers.review] : []),
  ];
  for (const role of active)
    if (role.provider === "deepseek")
      await checkDeepSeekModel(
        role,
        Math.min(config.providers.timeoutMs, 10000),
      );
}

export function prepareDeepSeek(
  request: ProviderRequest,
  schema: unknown,
  probe = false,
) {
  const options = validateDeepSeekConfig(request.config);
  const runDir = path.resolve(request.runDir);
  const home = request.session?.home ?? path.join(runDir, `${request.role}-dsh-home`);
  mkdirSync(home, { recursive: true });
  const noTools = probe || request.station === "intent";
  const allowTools = noTools ? [] : readTools;
  const maxTokens = generationLimit(request, probe);
  const measurementFile = path.join(runDir, `${request.role}-token-events.jsonl`);
  writeFileSync(measurementFile, "");
  // Remove model-visible capabilities as well as guarding execution. The guard
  // remains authoritative if a future DSH version registers an additional tool.
  const disabled = [
    "tool-plugin-manager",
    "tool-bash",
    "tool-pwsh",
    "tool-jobs",
    "tool-working-directory",
    "tool-skill",
    "tool-agent-team",
    "tool-subagent-control",
    "tool-subagent",
    "tool-subagent-fork",
    "tool-workflow",
    "tool-todo",
    "tool-goal",
    "tool-web",
    "tool-executor-ptc",
    "mcp-resources",
    "session-title-llm",
    "agent-instructions",
    "skill-filesystem",
    "compaction-basic",
    "command-compact",
    "deepseek-llm-api-extensions",
    "llm-deepseek",
    "llm-deepseek-account",
    "web-search-deepseek",
    "web-deepseek-api",
    "web-fetch-http",
    "command-feedback",
    "goal-round-driver",
  ];
  const overlay = [
    ...disabled.map((id) => ({ id, disabled: true })),
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          "ollama-local": {
            apiKeyEnv: "KITCHEN_OLLAMA_API_KEY",
            api: "openai-completions",
            baseURL: options.baseURL,
            compat: {
              supportsDeveloperRole: false,
              maxTokensField: "max_tokens",
            },
            retryPolicy: { mode: "normal", maxRetries: 0 },
            models: [
              {
                id: request.config.model,
                contextWindow: options.contextWindow,
                maxTokens,
              },
            ],
          },
        },
      },
    },
    {
      id: "agent-default-model",
      config: { provider: "ollama-local", model: request.config.model },
    },
    {
      id: "tool-fs",
      config: {
        read: !noTools,
        readImage: false,
        write: false,
        edit: false,
        applyPatch: false,
      },
    },
    { id: "tool-fs-search", disabled: noTools },
    {
      insert: [
        {
          id: "kitchen-read-only",
          name: fileURLToPath(new URL("./deepseek-guard.mjs", import.meta.url)),
          config: {
            allowTools,
            measurementFile,
            maxTokens,
            budget: tokenBudget(options, maxTokens),
            policy: options.tokenPolicy,
          },
        },
      ],
    },
    { id: "headless-runner", inject: ["headlessStartup", "kitchenReadOnly"] },
  ];
  const overlayText = stringify(overlay);
  const overlayFile = path.join(runDir, `${request.role}-dsh.patch.yml`);
  writeFileSync(overlayFile, overlayText);
  const guidance = options.tokenPolicy && request.station !== "intent" && !probe
    ? "\nUse targeted glob/grep and bounded reads; avoid rereading unchanged content. Keep summaries concise and return complete content.\n"
    : "";
  const input = `${request.prompt}${guidance}\n\nKITCHEN OUTPUT CONTRACT\nReturn exactly one JSON object matching this JSON Schema. Do not wrap it in Markdown or include commentary outside JSON. Never execute shell commands or write files; return proposed changes only in the schema.\n${JSON.stringify(schema)}\n`;
  return {
    command: resolveProviderExecutable("deepseek", request.config.executable),
    args: [
      "--yes",
      "--offline",
      `@deepseek-ai/dsh@${options.version}`,
      "--profile",
      "headless",
      "--patch",
      overlayFile,
      "--json",
      "--permission-mode",
      "read-only",
      "--approval-policy",
      "never",
      ...(request.session?.id ? ["--session-id", request.session.id] : []),
      "-",
    ],
    env: {
      DSH_HOME: home,
      DSH_TELEMETRY_MODE: "DISABLED",
      KITCHEN_OLLAMA_API_KEY: "ollama",
    },
    input,
    measurementFile,
    maxTokens,
    overlayFile,
    overlayHash: createHash("sha256").update(overlayText).digest("hex"),
  };
}

export function deepseekEventFailure(
  event: Record<string, unknown>,
  noTools = false,
): string | undefined {
  if (!eventTypes.has(String(event.type)))
    return `Unsupported DSH stream event: ${String(event.type)}`;
  if (event.type === "error")
    return `DSH error: ${String(event.message ?? event.code ?? "unknown error")}`;
  if (
    event.type === "tool_call" &&
    !(noTools ? [] : readTools).includes(String(event.tool))
  )
    return `KITCHEN_TOOL_DENIED: ${String(event.tool)}`;
  if (
    event.type === "tool_result" &&
    event.error &&
    typeof event.error === "object"
  ) {
    const code = String((event.error as Record<string, unknown>).code ?? "");
    if (/DENIED|PERMISSION|APPROVAL|SANDBOX|UNKNOWN_TOOL/.test(code))
      return `DSH tool policy failure: ${code}`;
  }
}

export class DeepSeekContractError extends Error {
  constructor(
    readonly detail: string,
    readonly sessionId: string,
    readonly evidencePath?: string,
  ) {
    super(`DSH final answer violated JSON contract; session=${sessionId}${evidencePath ? `; evidence=${evidencePath}` : ""}: ${detail}`);
    this.name = "DeepSeekContractError";
  }
}

export function deepseekFinalAnswer(
  raw: string,
  noTools = false,
): { sessionId: string; text: string } {
  let sessionId: string | undefined;
  let final: Record<string, unknown> | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Invalid JSON in DSH event stream.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid DSH stream event.");
    const event = value as Record<string, unknown>;
    const failure = deepseekEventFailure(event, noTools);
    if (failure) throw new Error(failure);
    if (final)
      throw new Error("DSH emitted events after its terminal final event.");
    if (event.type === "session") {
      if (sessionId || typeof event.sessionId !== "string" || !event.sessionId)
        throw new Error("Invalid DSH session event.");
      sessionId = event.sessionId;
    } else if (!sessionId)
      throw new Error("DSH stream must begin with a session event.");
    if (event.type === "final") final = event;
  }
  if (
    !final ||
    !sessionId ||
    final.sessionId !== sessionId ||
    typeof final.text !== "string" ||
    !final.reason ||
    typeof final.reason !== "object" ||
    (final.reason as Record<string, unknown>).kind !== "completed"
  )
    throw new Error(
      "DSH did not complete a matching session with a final answer.",
    );
  return { sessionId, text: final.text };
}

export function parseDeepSeekOutput(raw: string, noTools = false): unknown {
  const final = deepseekFinalAnswer(raw, noTools);
  try {
    return JSON.parse(final.text);
  } catch (error) {
    throw new DeepSeekContractError(
      error instanceof Error ? error.message : String(error), final.sessionId,
    );
  }
}
