import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Storage } from "../src/storage.ts";
import { loadConfig } from "../src/config.ts";
import { executeCheck } from "../src/checks.ts";

describe("recovery and execution boundaries", () => {
  it("recovers an interrupted run but never infers approval", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-recovery-"));
    const storage = new Storage(root);
    storage.save({
      version: 1,
      feature: "answer",
      request: "42",
      baseCommit: "a",
      branch: "codex/kitchen/answer",
      worktree: path.join(root, ".kitchen/worktrees/answer"),
      conversation: [],
      stations: {
        intent: {
          status: "running",
          runId: "x",
          summary: "",
          rubricVersion: "1",
          profileVersions: {},
          artifactFiles: [],
          findings: [],
          checks: [],
        },
      },
    });
    writeFileSync(
      path.join(storage.directory("answer"), "lock.json"),
      JSON.stringify({ pid: 2147483647 }),
    );
    await storage.lock("answer", async () => {
      expect(storage.read("answer").stations.intent?.status).toBe("failed");
      expect(storage.read("answer").stations.intent?.approval).toBeUndefined();
    });
  });
  it("rejects concurrent invocations on a feature", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-lock-"));
    const storage = new Storage(root);
    await storage.lock("answer", async () => {
      await expect(storage.lock("answer", async () => {})).rejects.toThrow(
        /busy/i,
      );
    });
  });
  it("rejects watch commands and behavioral profiles without test counts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-config-"));
    for (const profile of [
      {
        kind: "unit",
        command: "pnpm",
        args: ["dev"],
        parser: "vitest-json",
        timeoutMs: 1000,
      },
      {
        kind: "unit",
        command: "pnpm",
        args: ["test"],
        parser: "exit-code",
        timeoutMs: 1000,
      },
    ]) {
      writeFileSync(
        path.join(root, "kitchen.config.json"),
        JSON.stringify({ profiles: { unit: profile } }),
      );
      expect(() => loadConfig(root)).toThrow();
    }
  });
  it("reports absent fixtures as unverified", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-fixture-"));
    const result = await executeCheck({
      root,
      runDir: path.join(root, ".kitchen/evidence"),
      fingerprint: "candidate",
      green: true,
      definition: {
        id: "integration",
        profile: "integration",
        files: [],
        acIds: ["AC-1"],
        required: true,
        expectation: "green",
      },
      profile: {
        kind: "integration",
        command: process.execPath,
        args: [],
        parser: "vitest-json",
        timeoutMs: 1000,
        fixture: "missing-fixture",
      },
    });
    expect(result.status).toBe("unverified");
    expect(result.sourceFingerprint).toBe("candidate");
  });
  it("requires human observations with actual evidence and records them separately", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-manual-"));
    mkdirSync(path.join(root, "evidence"));
    writeFileSync(
      path.join(root, "evidence/flow.txt"),
      "Observed the candidate flow.",
    );
    const input = {
      root,
      runDir: path.join(root, ".kitchen/evidence"),
      fingerprint: "candidate",
      green: true,
      definition: {
        id: "flow",
        profile: "manual",
        files: [],
        acIds: ["AC-1"],
        required: true,
        expectation: "green" as const,
      },
      profile: { kind: "manual" as const },
    };
    expect((await executeCheck(input)).status).toBe("unverified");
    const result = await executeCheck({
      ...input,
      observations: [
        {
          id: "flow",
          observation: "Observed 42",
          evidence: ["evidence/flow.txt"],
          status: "passed",
        },
      ],
    });
    expect(result).toMatchObject({
      status: "passed",
      observation: "Observed 42",
    });
    expect(
      readFileSync(path.join(input.runDir, "manual-flow.json"), "utf8"),
    ).toContain("Observed 42");
  });
});
