import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { captureReplay, replayStation } from "../src/replay.ts";
import { fixture } from "./workflow-fixture.ts";

describe("replay capture with real source inventory", () => {
  it("freezes source, prompt and effective configuration without mutating the feature state", async () => {
    const setup = fixture();
    await setup.kitchen.start("answer", { request: "Return 42" });
    const state = await setup.kitchen.run("answer", "intent");
    const stateFile = path.join(setup.root, ".kitchen/features/answer/state.json");
    const before = readFileSync(stateFile, "utf8");
    const evidence = path.join(setup.root, ".kitchen/features/answer/runs", state.stations.intent!.runId, "author");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(path.join(evidence, "author-process.json"), JSON.stringify({ cwd: state.worktree, code: 0,
      provider: "codex", model: "original", metrics: { station: "intent" } }));
    writeFileSync(path.join(evidence, "author-prompt.txt"), "You are the author at the intent station.\nSAVED REQUEST\nDOCUMENT docs/features/answer/spec.md\n| AC-1 | Answer | Returns 42 |\nCHECK PROFILES (human-controlled):\n{}\nBASELINE: original\n");
    writeFileSync(path.join(evidence, "author-events.jsonl"), '{"type":"turn.completed"}\n');
    writeFileSync(path.join(evidence, "author-answer.json"), JSON.stringify(state.stations.intent!.output));
    const bundle = path.join(setup.root, ".kitchen/capture");
    const manifest = await captureReplay({ project: setup.root, evidence, output: bundle });
    expect(manifest).toMatchObject({ recordedProvider: { provider: "codex", model: "original" }, origin: { configurationRoot: setup.root } });
    expect(manifest.files).toHaveProperty("src/answer.ts");
    expect(manifest.savedValidation).toEqual({ profiles: {}, acIds: ["AC-1"], provenance: "saved-request" });
    expect(manifest.profiles).toHaveProperty("unit");
    expect(manifest.files).not.toHaveProperty(".kitchen/features/answer/state.json");
    expect(readFileSync(stateFile, "utf8")).toBe(before);
    expect((await replayStation({ bundle, output: path.join(setup.root, ".kitchen/offline-result") })).valid).toBe(true);
    writeFileSync(path.join(state.worktree, "src/answer.ts"), "changed after capture");
    expect((await replayStation({ bundle, output: path.join(setup.root, ".kitchen/second-result") })).valid).toBe(true);
    expect(readFileSync(path.join(bundle, "source/src/answer.ts"), "utf8")).toContain("export const answer = 0");
  });
});
