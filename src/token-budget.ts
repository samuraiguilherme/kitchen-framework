import type {
  DeepSeekOptions,
  DeepSeekTokenPolicy,
  ProviderRequest,
  RoleConfig,
  TokenMetrics,
  TokenStep,
} from "./types.ts";

export const tokenPromptVersion = 1;
export const compactDeepSeek = (role: RoleConfig): boolean =>
  role.provider === "deepseek" &&
  !!role.dsh?.tokenPolicy &&
  role.dsh.tokenPolicy.compactContext !== false;

export function tokenBudget(
  options: Pick<DeepSeekOptions, "contextWindow" | "maxTokens" | "tokenPolicy">,
  outputTokens: number,
) {
  const maxInputTokens = options.contextWindow - outputTokens -
    (options.tokenPolicy?.safetyMarginTokens ?? 512);
  return {
    maxInputTokens,
    initialInputTarget: maxInputTokens -
      (options.tokenPolicy?.toolHistoryReserveTokens ?? 1024),
    counting: "utf8-bytes-div-3-estimate" as const,
  };
}

export function validateTokenPolicy(
  value: unknown,
  options: Pick<DeepSeekOptions, "contextWindow" | "maxTokens">,
): asserts value is DeepSeekTokenPolicy {
  const fail = () => {
    throw new Error(
      "Invalid DeepSeek token policy: require version 1, supported fields, nonnegative reserves, positive limits and output caps no larger than maxTokens.",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const policy = value as DeepSeekTokenPolicy;
  const fields = [
    "version", "compactContext", "safetyMarginTokens", "toolHistoryReserveTokens",
    "maxSteps", "maxToolCalls", "maxToolResultBytes", "maxInputBytes", "outputTokens",
  ];
  if (
    policy.version !== 1 ||
    Object.keys(policy).some((key) => !fields.includes(key)) ||
    (policy.compactContext !== undefined && typeof policy.compactContext !== "boolean")
  ) fail();
  for (const key of [
    "safetyMarginTokens", "toolHistoryReserveTokens", "maxSteps",
    "maxToolCalls", "maxToolResultBytes", "maxInputBytes",
  ] as const) {
    const number = policy[key];
    const minimum = [
      "safetyMarginTokens", "toolHistoryReserveTokens", "maxToolCalls",
    ].includes(key) ? 0 : 1;
    if (number !== undefined && (!Number.isSafeInteger(number) || number < minimum))
      fail();
  }
  if (tokenBudget({ ...options, tokenPolicy: policy }, options.maxTokens).initialInputTarget < 1)
    fail();
  if (policy.outputTokens !== undefined) {
    if (!policy.outputTokens || typeof policy.outputTokens !== "object" || Array.isArray(policy.outputTokens))
      fail();
    for (const [key, cap] of Object.entries(policy.outputTokens))
      if (
        !["probe", "review", "discovery"].includes(key) ||
        !Number.isSafeInteger(cap) || cap < 1 || cap > options.maxTokens
      ) fail();
  }
}

export function generationLimit(request: ProviderRequest, probe = false): number {
  const options = request.config.dsh!;
  const kind = probe ? "probe"
    : request.kind === "discovery" ? "discovery"
    : request.role === "review" ? "review" : undefined;
  return (kind && options.tokenPolicy?.outputTokens?.[kind]) || options.maxTokens;
}

export function summarizeTokenEvents(
  events: Array<Record<string, unknown>>,
): TokenMetrics {
  const steps = new Map<number, TokenStep>();
  const result: TokenMetrics = {
    source: "dsh-llm-stream", counting: "utf8-bytes-div-3-estimate", modelSteps: 0,
    steps: [], usageComplete: false, knownInputTokens: 0, knownOutputTokens: 0,
    knownTotalTokens: 0, toolResultBytes: 0, warnings: [],
  };
  for (const event of events) {
    if (event.type === "failure") result.failure = String(event.message);
    if (event.warning) result.warnings.push(String(event.warning));
    if (typeof event.step !== "number") continue;
    if (event.type === "request")
      steps.set(event.step, {
        step: event.step,
        inputBytes: Number(event.inputBytes),
        estimatedInputTokens: Number(
          event.estimatedInputTokens ?? Math.ceil(Number(event.inputBytes) / 3),
        ),
        toolResultBytes: Number(event.toolResultBytes),
        sectionBytes: event.sectionBytes as Record<string, number> | undefined,
      });
    const step = steps.get(event.step);
    if (event.type === "response" && step) {
      step.usage = event.usage as Record<string, number> | undefined;
      step.finish = event.finish as string | undefined;
      result.terminationReason = step.finish;
    }
  }
  result.steps = [...steps.values()];
  result.modelSteps = steps.size;
  result.usageComplete = steps.size > 0 && !events.some((event) => event.incompleteUsage);
  for (const step of result.steps) {
    const usage = step.usage;
    const valid = (key: string) =>
      typeof usage?.[key] === "number" && Number.isFinite(usage[key]) && usage[key]! >= 0;
    for (const key of ["inputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
      if (valid(key)) result.knownInputTokens += usage![key]!;
      else if (key === "inputTokens" || usage?.[key] !== undefined)
        result.usageComplete = false;
    }
    if (valid("outputTokens")) result.knownOutputTokens += usage!.outputTokens!;
    else result.usageComplete = false;
    // pi-ai can materialize all-zero counters when the wire response omitted
    // usage. Nonempty inference cannot qualify savings from those defaults.
    const input = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) +
      (usage?.cacheWriteTokens ?? 0);
    if (usage && (input <= 0 || usage.outputTokens === 0)) {
      result.usageComplete = false;
      result.warnings.push(`Step ${step.step}: zero counters may be adapter defaults; provider usage is incomplete.`);
    }
    result.toolResultBytes = Math.max(result.toolResultBytes, step.toolResultBytes);
  }
  result.knownTotalTokens = result.knownInputTokens + result.knownOutputTokens;
  if (result.usageComplete) result.totalTokens = result.knownTotalTokens;
  return result;
}
