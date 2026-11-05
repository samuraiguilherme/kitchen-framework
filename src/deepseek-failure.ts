import { deepseekTerminal } from "./deepseek.ts";
import { tokenBudget } from "./token-budget.ts";
import type { ProcessResult } from "./process.ts";
import type { ProviderRequest, TokenMetrics } from "./types.ts";

export interface DeepSeekFailureInfo {
  kind: "generation-exhausted" | "context-exhausted" | "token-limit-unresolved" |
    "stream-idle-timeout" | "deadline" | "cancelled" | "policy-limit" | "process" | "stream";
  sessionId?: string;
  effectiveMaxTokens: number;
  contextWindow: number;
  allocatedContextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  nextMaxTokens?: number;
  action: string;
}

export class DeepSeekFailure extends Error {
  constructor(readonly info: DeepSeekFailureInfo, readonly evidencePath: string, detail: string) {
    super(`deepseek failed: ${detail}; kind=${info.kind}; maxTokens=${info.effectiveMaxTokens}; ` +
      `context=${info.allocatedContextWindow ?? "unverified"}/${info.contextWindow}; ` +
      `input=${info.inputTokens ?? "unknown"}; output=${info.outputTokens ?? "unknown"}` +
      `${info.sessionId ? `; session=${info.sessionId}` : ""}; evidence=${evidencePath}. ${info.action}`);
    this.name = "DeepSeekFailure";
  }
}

export function classifyDeepSeekFailure(
  request: ProviderRequest,
  result: ProcessResult,
  tokens: TokenMetrics,
  effectiveMaxTokens: number,
  allocatedContextWindow?: number,
): DeepSeekFailureInfo {
  const options = request.config.dsh!;
  const info: DeepSeekFailureInfo = {
    kind: "process", effectiveMaxTokens, contextWindow: options.contextWindow, allocatedContextWindow,
    action: "Inspect the retained provider evidence before retrying.",
  };
  if (result.cancelled || request.signal?.aborted) return { ...info, kind: "cancelled" };
  if (result.timedOut) return { ...info, kind: "deadline", action: "Qualify the task within the outer deadline." };
  if (tokens.failureKinds?.some(kind => ["policy-limit", "tool-policy"].includes(kind)))
    return { ...info, kind: "policy-limit", action: "Split the task or qualify the explicit tool/input limits." };
  // Classification is diagnostic only. Retry eligibility below requires a
  // validated terminal stream, measured usage and a verified allocation.
  if (/stream idle timeout/i.test(tokens.failure ?? result.failureReason ?? result.stderr))
    return { ...info, kind: "stream-idle-timeout", action: "Qualify streamIdleTimeoutMs and model load/prefill latency." };
  const rawCode = result.rawCode ?? result.code;
  if (result.failureReason || ![0, 1].includes(rawCode ?? -1)) return info;
  let final;
  try {
    final = deepseekTerminal(result.stdout, request.station === "intent");
    if (request.session?.id && final.sessionId !== request.session.id) return { ...info, kind: "stream" };
    info.sessionId = final.sessionId;
  } catch { return { ...info, kind: "stream" }; }
  if (final.reason !== "max-tokens" || tokens.terminationReason !== "max-tokens") return info;

  info.kind = "token-limit-unresolved";
  info.action = "Verify context allocation and per-step usage; split the task or qualify larger limits.";
  const inputs = tokens.steps.map(step => {
    const usage = step.usage;
    return usage && usage.inputTokens! + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  });
  const lastOutput = tokens.steps.at(-1)?.usage?.outputTokens;
  if (inputs.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0) && inputs.length)
    info.inputTokens = Math.max(...inputs as number[]);
  if (typeof lastOutput === "number" && Number.isFinite(lastOutput) && lastOutput >= 0) info.outputTokens = lastOutput;
  const context = Math.min(options.contextWindow, allocatedContextWindow ?? options.contextWindow);
  const budget = tokenBudget({ ...options, contextWindow: context }, effectiveMaxTokens);
  if (info.inputTokens !== undefined && info.inputTokens > budget.maxInputTokens)
    return { ...info, kind: "context-exhausted", action: "Reduce repository/tool history or qualify a larger Ollama num_ctx allocation; increasing output alone reduces input space." };

  if (!tokens.usageComplete || tokens.failureKinds?.some(kind => kind !== "max-tokens") ||
    allocatedContextWindow === undefined || allocatedContextWindow < options.contextWindow ||
    info.outputTokens === undefined || info.outputTokens < effectiveMaxTokens)
    return info;

  info.kind = "generation-exhausted";
  const next = Math.min(2 * effectiveMaxTokens, options.maxTokens);
  if (options.tokenPolicy?.maxTokenRetries === 1 && next > effectiveMaxTokens &&
    info.inputTokens !== undefined && info.inputTokens <= tokenBudget(options, next).maxInputTokens)
    info.nextMaxTokens = next;
  info.action = info.nextMaxTokens
    ? `Regenerate once in a fresh session with maxTokens=${info.nextMaxTokens}.`
    : "Qualify a larger output/context budget or split the task; the current recovery ceiling cannot increase safely.";
  return info;
}
