import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSmokeProject, smokeQualification } from "../scripts/smoke-claude.ts";
import { loadConfig } from "../src/config.ts";
import { runProcess } from "../src/process.ts";
import type { FeatureState } from "../src/types.ts";

describe("Claude live qualification fixture", () => {
  it("requires an answer after a model question rather than counting the initial request", () => {
    const project = mkdtempSync(path.join(tmpdir(), "kitchen-claude-status-"));
    const state: FeatureState = {
      version: 1, feature: "claude-smoke", request: "Return 42", baseCommit: "baseline", branch: "fixture", worktree: project, stations: {},
      conversation: [
        { role: "operator", station: "intent", text: "Return 42", at: "initial" },
        { role: "model", station: "intent", text: "Who uses it?", at: "question" },
      ],
    };
    const config = loadConfig(project);
    const report = { project, attempts: [] };
    expect(smokeQualification(state, config, report).questionsAndAnswers).toBe(false);
    config.stations = { verify: { reviewEnabled: true }, publish: { reviewEnabled: true } };
    config.providers.review = { provider: "codex" };
    expect(smokeQualification(state, config, report).independentReview).toBe(false);
    state.conversation.push({ role: "operator", station: "intent", text: "Developers", at: "answer" });
    expect(smokeQualification(state, config, report).questionsAndAnswers).toBe(true);
  });

  it("creates a disposable project and executes real assertion RED and GREEN", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "kitchen-claude-smoke-"));
    const project = await createSmokeProject(directory, { model: "selected-model" });
    expect(loadConfig(project)).toMatchObject({
      providers: { author: { provider: "claude", model: "selected-model" }, review: { provider: "codex" } },
      discovery: { enabled: true }, stations: { verify: { reviewEnabled: true }, publish: { reviewEnabled: true } },
    });
    await expect(createSmokeProject(directory)).rejects.toThrow(/must be empty/);
    const file = path.join(project, "src/answer.test.mjs");
    writeFileSync(file, "import assert from 'node:assert/strict'; import { answer } from './answer.mjs'; export const tests = [{ name: 'AC-1 returns 42', run() { assert.equal(answer(), 42); } }];\n");
    const run = () => runProcess({ command: process.execPath, args: ["unit-runner.mjs", file], cwd: project, timeoutMs: 10000 });
    const red = await run();
    expect(red.code).toBe(1);
    expect(JSON.parse(red.stdout).testResults[0].assertionResults[0].failureMessages[0]).toContain("AssertionError");
    writeFileSync(path.join(project, "src/answer.mjs"), "export function answer() { return 42; }\n");
    const green = await run();
    expect(green.code).toBe(0);
    expect(JSON.parse(green.stdout)).toMatchObject({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 });
    expect(readFileSync(path.join(project, "read-proof.txt"), "utf8").trim()).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("defaults to a description without provider calls or filesystem writes", async () => {
    const result = await runProcess({ command: process.execPath, args: ["--import", "tsx", fileURLToPath(new URL("../scripts/smoke-claude.ts", import.meta.url))], cwd: fileURLToPath(new URL("../", import.meta.url)), timeoutMs: 10000 });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("--init");
    expect(result.stdout).toContain("human checkpoints");
  });
});
