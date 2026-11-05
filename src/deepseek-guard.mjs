// This module runs inside DSH. The runner must depend on kitchenReadOnly so
// a missing or incompatible guard fails startup before any model task.
import { appendFileSync } from "node:fs";

export const name = "kitchen-read-only";
export const inject = ["tools"];

export function apply(ctx, config) {
  if (
    typeof ctx.tools?.guard !== "function" ||
    typeof ctx.provide !== "function"
  )
    throw new Error("DSH does not support Kitchen's required tool guard.");
  const allowed = new Set(config.allowTools);
  if ([...allowed].some((tool) => !["read", "glob", "grep"].includes(tool)))
    throw new Error("Invalid Kitchen tool allowlist.");
  let calls = 0;
  const record = (event) => {
    if (config.measurementFile)
      appendFileSync(config.measurementFile, JSON.stringify(event) + "\n");
  };
  const failure = (message) => {
    const detail = `KITCHEN_TOKEN_BUDGET: ${message}. Split the task or qualify larger limits; no content was truncated`;
    record({ type: "failure", kind: "policy-limit", message: detail });
    return detail;
  };
  ctx.tools.guard((call) => {
    if (!allowed.has(call.name)) {
      const message = `KITCHEN_TOOL_DENIED: ${call.name}`;
      record({ type: "failure", kind: "tool-policy", message });
      return message;
    }
    if (config.policy && ++calls > (config.policy.maxToolCalls ?? 12))
      return failure(`tool-call limit ${config.policy.maxToolCalls ?? 12} exceeded`);
  });
  if (config.measurementFile) {
    if (typeof ctx.on !== "function")
      throw new Error("DSH does not support Kitchen's required model-call instrumentation.");
    let steps = 0;
    ctx.on("llm/stream", async function* (options, next) {
      const step = ++steps;
      // Preserve the immutable loop request. This is the complete harness
      // projection, not an assertion that JSON bytes are provider tokens.
      const request = {
        provider: options.provider, model: options.model,
        reasoningEffort: options.reasoningEffort,
        temperature: options.temperature, stop: options.stop,
        system: options.system, messages: options.messages,
        tools: options.tools, toolHistory: options.toolHistory,
        maxTokens: options.maxTokens,
      };
      const bytes = (value) => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
      const inputBytes = bytes(request);
      const estimatedInputTokens = Math.ceil(inputBytes / 3);
      const toolResultBytes = (options.messages ?? [])
        .filter((message) => message.role === "tool")
        .reduce((total, message) => total + bytes(message.content), 0);
      const sectionBytes = Object.fromEntries(["system", "messages", "tools", "toolHistory"]
        .map((key) => [key, bytes(request[key])]));
      const target = step === 1 ? config.budget.initialInputTarget : config.budget.maxInputTokens;
      record({ type: "request", step, request, inputBytes, estimatedInputTokens,
        toolResultBytes, sectionBytes,
        ...(config.policy && estimatedInputTokens > target ? {
          warning: `Estimated input ${estimatedInputTokens} exceeds target ${target}; counting is advisory (UTF-8 bytes / 3). Sections: ${JSON.stringify(sectionBytes)}`,
        } : {}),
      });
      const deny = config.policy && (
        step > (config.policy.maxSteps ?? 8) ? `model-step limit ${config.policy.maxSteps ?? 8} exceeded` :
        toolResultBytes > (config.policy.maxToolResultBytes ?? 32768) ? `tool history ${toolResultBytes} bytes exceeds ${config.policy.maxToolResultBytes ?? 32768}` :
        config.policy.maxInputBytes && inputBytes > config.policy.maxInputBytes ? `input ${inputBytes} bytes exceeds ${config.policy.maxInputBytes}; sections ${JSON.stringify(sectionBytes)}` : undefined
      );
      if (deny) {
        const message = failure(deny);
        record({ type: "response", step, finish: "budget-exceeded" });
        yield { type: "finish", reason: { kind: "error", failure: { code: "KITCHEN_TOKEN_BUDGET", message } } };
        return;
      }
      let usage;
      let finish;
      try {
        for await (const chunk of next()) {
          if (chunk.type === "usage") usage = chunk.usage;
          if (chunk.type === "finish") {
            finish = chunk.reason.kind;
            // DSH's inputTokens excludes its separately counted cache reads
            // and writes; outputTokens already includes reasoning.
            const input = usage && usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
            if (config.policy && Number.isFinite(input) && input > config.budget.maxInputTokens) {
              const message = failure(`reported input ${input} tokens exceeds ${config.budget.maxInputTokens}`);
              finish = "budget-exceeded";
              yield { type: "finish", reason: { kind: "error", failure: { code: "KITCHEN_TOKEN_BUDGET", message } } };
              return;
            }
            if (!["stop", "tool-calls"].includes(finish))
              record({ type: "failure", kind: finish, code: chunk.reason.failure?.code,
                message: `DSH model stopped with ${finish}: ${chunk.reason.failure?.message ?? "incomplete generation"}` });
          }
          yield chunk;
        }
      } catch (error) {
        record({ type: "failure", kind: "stream-error", message: String(error) });
        throw error;
      } finally {
        record({ type: "response", step, usage, finish: finish ?? "interrupted" });
      }
    });
  }
  ctx.provide("kitchenReadOnly", Object.freeze({}));
}
