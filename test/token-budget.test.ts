import { describe, expect, it } from "vitest";
import {
  generationLimit,
  tokenBudget,
  validateTokenPolicy,
  summarizeTokenEvents,
} from "../src/token-budget.ts";
import type { ProviderRequest } from "../src/types.ts";

const options = { contextWindow: 8192, maxTokens: 2048 };
describe("DeepSeek token policy", () => {
  it("reserves generation, safety, and tool history without treating byte estimates as exact", () => {
    expect(tokenBudget(options, 2048)).toEqual({
      maxInputTokens: 5632,
      initialInputTarget: 4608,
      counting: "utf8-bytes-div-3-estimate",
    });
  });
  it.each([
    null, {}, { version: 2 }, { version: 1, maxSteps: 0 },
    { version: 1, maxToolCalls: -1 }, { version: 1, compactContext: "yes" },
    { version: 1, safetyMarginTokens: 7000 },
    { version: 1, outputTokens: { review: 2049 } },
    { version: 1, outputTokens: { typo: 512 } },
    { version: 1, unexpected: true },
    { version: 1, maxTokenRetries: 2 },
    { version: 1, maxTokenRetries: -1 },
    { version: 1, outputTokens: { author: 2049 } },
  ])("rejects invalid or misspelled policies %j", (policy) => {
    expect(() => validateTokenPolicy(policy, options)).toThrow(/token policy/i);
  });
  it("allows an initial author cap below the hard ceiling and an explicit single retry", () => {
    const policy = { version: 1, maxTokenRetries: 1, outputTokens: { author: 1024 } };
    expect(() => validateTokenPolicy(policy, options)).not.toThrow();
    expect(generationLimit({ role: "author", config: { dsh: { ...options, tokenPolicy: policy } } } as ProviderRequest)).toBe(1024);
  });
  it("keeps author file outputs at the configured cap while allowing explicit short-task caps", () => {
    const request = {
      role: "author", config: { dsh: { ...options, tokenPolicy: {
        version: 1, outputTokens: { probe: 256, review: 1024, discovery: 768 },
      } } },
    } as ProviderRequest;
    expect(generationLimit(request)).toBe(2048);
    expect(generationLimit(request, true)).toBe(256);
    expect(generationLimit({ ...request, role: "review" })).toBe(1024);
    expect(generationLimit({ ...request, kind: "discovery" })).toBe(768);
  });
  it("retains partial usage and counts cached input and reasoning without double counting", () => {
    const result = summarizeTokenEvents([
      { type: "request", step: 1, inputBytes: 30, toolResultBytes: 0 },
      { type: "response", step: 1, usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 8, reasoningTokens: 6 }, finish: "tool-calls" },
      { type: "request", step: 2, inputBytes: 90, toolResultBytes: 15 },
      { type: "response", step: 2, finish: "error" },
    ]);
    expect(result).toMatchObject({
      modelSteps: 2, usageComplete: false, knownInputTokens: 15,
      knownOutputTokens: 8, knownTotalTokens: 23, toolResultBytes: 15,
      terminationReason: "error",
    });
    expect(result.totalTokens).toBeUndefined();
    expect(summarizeTokenEvents([]).usageComplete).toBe(false);
    expect(summarizeTokenEvents([
      { type: "request", step: 1, inputBytes: 30, toolResultBytes: 0 },
      { type: "response", step: 1, usage: { inputTokens: 10 }, finish: "interrupted" },
    ])).toMatchObject({ knownInputTokens: 10, knownOutputTokens: 0, usageComplete: false });
    const unknownUsage = summarizeTokenEvents([
      { type: "request", step: 1, inputBytes: 30, toolResultBytes: 0 },
      { type: "response", step: 1, usage: { inputTokens: 0, outputTokens: 0 }, finish: "stop" },
    ]);
    expect(unknownUsage.usageComplete).toBe(false);
    expect(unknownUsage.totalTokens).toBeUndefined();
  });
});
