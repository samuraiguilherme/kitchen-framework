import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process.ts";
import { Storage } from "../src/storage.ts";
import type { FeatureState } from "../src/types.ts";

function fixture(status: "awaiting-input" | "failed" = "awaiting-input") {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-cli-"));
  execFileSync("git", ["init", "--initial-branch=develop"], {
    cwd: root,
    stdio: "pipe",
  });
  const storage = new Storage(root);
  const state: FeatureState = {
    version: 1,
    feature: "answer",
    request: "Return 42.",
    baseCommit: "baseline",
    branch: "codex/kitchen/answer",
    worktree: path.join(root, ".kitchen/worktrees/answer"),
    conversation: [],
    stations: {
      intent: {
        status,
        runId: "pending",
        rubricVersion: "1",
        profileVersions: {},
        findings: [],
        checks: [],
        summary: "Need audience",
        artifactFiles: [],
        output: {
          summary: "Need audience",
          questions: [{ id: "audience", text: "Who needs the answer?" }],
          document: null,
          files: [],
          allowedPaths: [],
          unitTestFiles: [],
          scaffoldFiles: [],
          checks: [],
        },
      },
    },
  };
  storage.save(state);
  const invoke = (args: string[]) =>
    runProcess({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        ...args,
      ],
      cwd: root,
      timeoutMs: 15000,
    });
  return { storage, state, invoke };
}

describe("CLI workflow pauses", () => {
  it.each([false, true])(
    "reports pending answers without failing or approving (json: %s)",
    async (json) => {
      const { storage, state, invoke } = fixture();
      const before = readFileSync(storage.file("answer"), "utf8");
      const result = await invoke([
        "approve",
        "answer",
        "intent",
        ...(json ? ["--json"] : []),
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      if (json) expect(JSON.parse(result.stdout)).toEqual(state);
      else {
        expect(result.stdout).toContain("intent: awaiting-input");
        expect(result.stdout).toContain("Who needs the answer?");
        expect(result.stdout).toContain(
          "Approval paused; no approval recorded.",
        );
        expect(result.stdout.match(/Next:/g)).toHaveLength(1);
        expect(result.stdout).toContain("pnpm kitchen run answer intent");
      }
      expect(result.stdout).not.toContain(
        "Your name for this acceptance record?",
      );
      expect(readFileSync(storage.file("answer"), "utf8")).toBe(before);
      expect(
        existsSync(path.join(state.worktree, "docs/features/answer/intent.md")),
      ).toBe(false);
    },
  );
  it("keeps failed stations on the error path", async () => {
    const { invoke } = fixture("failed");
    const result = await invoke(["approve", "answer", "intent"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not awaiting approval (status: failed)");
  });
});
