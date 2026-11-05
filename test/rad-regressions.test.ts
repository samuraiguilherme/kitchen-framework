import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDeepSeekOutput } from "../src/deepseek.ts";
import { validateAuthorOutput } from "../src/providers.ts";
import { classifyDeepSeekFailure } from "../src/deepseek-failure.ts";
import { inspectReplayOutput } from "../src/replay.ts";
import type { ProviderRequest, TokenMetrics } from "../src/types.ts";

const cases = JSON.parse(readFileSync(new URL("./fixtures/rad-regressions.json", import.meta.url), "utf8"));
const empty = { summary: "Brand subtitle", questions: [], document: null, files: [], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [] };
const wire = (text: string, reason = "completed") => [
  { type: "session", sessionId: "rad-regression" },
  { type: "final", sessionId: "rad-regression", reason: { kind: reason }, text },
].map(event => JSON.stringify(event)).join("\n");

describe("RAD regression corpus", () => {
  it("rejects source proposals at the spec station before any apply or review", () => {
    const candidate = { ...empty, files: [{ path: "src/brand.tsx", action: "write", kind: "implementation", content: "new subtitle" }] };
    expect(() => validateAuthorOutput(candidate, "spec")).toThrow(cases.documentProposal.expected);
  });
  it("rejects fenced JSON and partial or cancelled streams rather than salvaging them", () => {
    expect(() => parseDeepSeekOutput(wire(cases.fencedJson.text))).toThrow(/JSON contract/);
    expect(() => parseDeepSeekOutput(wire(JSON.stringify(empty), cases.cancelled.terminalReason))).toThrow(/did not complete/);
    expect(() => parseDeepSeekOutput('{"type":"session","sessionId":"rad-regression"}\n')).toThrow(/did not complete/);
  });
  it("classifies the measured one-token spec stop as context exhaustion without output-cap recovery", () => {
    const c = cases.contextPressure;
    const request: ProviderRequest = { station: "spec", role: "author", cwd: ".", runDir: ".", prompt: "", timeoutMs: 1000,
      config: { provider: "deepseek", model: "fixture", dsh: { version: "0.2.2-alpha.3", baseURL: "http://127.0.0.1:11434/v1", contextWindow: c.contextWindow, maxTokens: c.maxTokens, tokenPolicy: { version: 1, maxTokenRetries: 1 } } } };
    const tokens: TokenMetrics = { source: "dsh-llm-stream", counting: "utf8-bytes-div-3-estimate", modelSteps: 1,
      steps: [{ step: 1, inputBytes: 0, estimatedInputTokens: 0, toolResultBytes: 0, usage: { inputTokens: c.inputTokens, outputTokens: c.outputTokens } }],
      usageComplete: true, knownInputTokens: c.inputTokens, knownOutputTokens: c.outputTokens, knownTotalTokens: c.inputTokens + c.outputTokens,
      toolResultBytes: 0, warnings: [], terminationReason: "max-tokens" };
    const info = classifyDeepSeekFailure(request, { code: 1, rawCode: 1, stdout: wire("", "max-tokens"), stderr: "", cancelled: false, timedOut: false }, tokens, c.maxTokens, c.contextWindow);
    expect(info).toMatchObject({ kind: "context-exhausted", inputTokens: 13337, outputTokens: 1 });
    expect(info.nextMaxTokens).toBeUndefined();
  });
  it("reproduces unknown profiles, uncovered criteria and missing unit evidence in test-plan replay", () => {
    const candidate = { ...empty, document: "# Test plan\n## Acceptance coverage\nAC-1\n## Unit tests\ntests/brand.test.ts\n## Regression\nPreserve the suite.\n## Required evidence\nRED then GREEN.",
      unitTestFiles: ["tests/brand.test.ts"], checks: cases.missingProfiles.profiles.map((profile: string) => ({ id: profile, profile, files: ["tests/brand.test.ts"], acIds: ["AC-1"], required: true, expectation: "red" })) };
    const issues = inspectReplayOutput({ station: "test-plan", role: "author", profiles: {}, acIds: ["AC-1"] }, candidate);
    for (const expected of ["unknown-profile: vitest", "unknown-profile: manual", "uncovered-criterion: AC-1", "unit-tests-required:"])
      expect(issues.some(issue => issue.startsWith(expected))).toBe(true);
  });
});
