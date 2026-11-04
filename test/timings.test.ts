import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { intervalUnion, readTimings } from "../src/timings.ts";
import { providerProgress } from "../src/provider-progress.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(path.join(tmpdir(), "kitchen-timings-")); roots.push(root); return root; };
describe("offline timing evidence", () => {
  it("separates concurrent elapsed time from work and includes failures, retries and partial runs", () => {
    const root = fixture();
    const write = (file: string, value: unknown) => { const p = path.join(root, ".kitchen/features/demo/runs", file); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(value)); };
    write("one/metrics.json", { station: "plan", status: "failed", completedAt: "done", durationMs: 3500, humanWaitMs: 500 });
    for (const [name, start, duration, code] of [["discovery-implementation", 0, 2000, 0], ["discovery-verification", 1000, 2000, 1], ["discovery-verification/contract-retry", 3000, 500, 1]] as const)
      write(`one/${name}/author-process.json`, { provider: "deepseek", code, startedAt: new Date(start).toISOString(), metrics: { durationMs: duration } });
    write("two/author/author-live.json", { station: "spec", provider: "deepseek", sessionId: "session-partial", startedAt: new Date(10000).toISOString(), durationMs: 800 });
    const before = readFileSync(path.join(root, ".kitchen/features/demo/runs/one/metrics.json"), "utf8");
    const report = readTimings(root, "demo");
    expect(report.totals).toMatchObject({ runs: 2, measuredRuns: 1, partialRuns: 1, activeMs: 3500, humanWaitMs: 500, providerWorkMs: 5300, providerElapsedMs: 4300 });
    expect(report.runs[0]?.attempts).toHaveLength(3);
    expect(report.runs[1]?.attempts[0]).toMatchObject({ status: "incomplete", sessionId: "session-partial" });
    expect(readFileSync(path.join(root, ".kitchen/features/demo/runs/one/metrics.json"), "utf8")).toBe(before);
    expect(intervalUnion([[0, 3], [1, 2], [3, 4], [6, 7]])).toBe(5);
  });
  it("checkpoints model/tool spans before process completion and preserves terminal reasons", () => {
    const root = fixture();
    const p = providerProgress({ station: "spec", role: "author", config: { provider: "deepseek", model: "local" }, runDir: root, cwd: root, prompt: "", timeoutMs: 1000 });
    const send = (event: unknown) => p.capture("stdout", JSON.stringify(event) + "\n");
    send({ type: "session", sessionId: "session-1" });
    send({ type: "status", phase: "step_start", step: 1 });
    send({ type: "tool_call", tool: "read", callId: "read-1" });
    const live = () => JSON.parse(readFileSync(path.join(root, "author-live.json"), "utf8"));
    expect(live()).toMatchObject({ station: "spec", model: "local", sessionId: "session-1", toolCount: 1 });
    expect(live().spans.every((span: { durationMs?: number }) => span.durationMs === undefined)).toBe(true);
    send({ type: "tool_result", callId: "read-1", status: "completed" });
    send({ type: "status", phase: "step_end", step: 1, usage: { inputTokens: 10, outputTokens: 1 } });
    send({ type: "final", sessionId: "session-1", reason: { kind: "completed" }, text: "{}" });
    expect(live().spans.every((span: { durationMs?: number }) => typeof span.durationMs === "number")).toBe(true);
    expect(live().terminationReason).toBe("completed");
  });
});
