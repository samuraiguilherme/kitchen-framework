import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process.ts";
import { Storage } from "../src/storage.ts";
import type { FeatureState } from "../src/types.ts";

const bin = fileURLToPath(new URL("../bin/kitchen.mjs", import.meta.url));
const invokeCli = (cwd: string, args: string[]) => runProcess({
  command: process.execPath,
  args: [bin, ...args],
  cwd,
  timeoutMs: 15000,
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: "pipe",
}).trim();

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
    invokeCli(root, args);
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
        expect(result.stdout).toContain("kitchen run answer intent");
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

describe("standalone CLI", () => {
  it("shows help outside a Git repository", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "kitchen-help-"));
    const result = await invokeCli(cwd, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("kitchen init [--base <branch>]");
    expect(result.stdout).toContain("--cwd <path>");
    expect(result.stdout).not.toContain("pnpm kitchen");
  });

  it("initializes another project, preserves user files, and shares state with its worktrees", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "kitchen caller "));
    const root = path.join(cwd, "target project");
    mkdirSync(path.join(root, "docs/_templates"), { recursive: true });
    // A consuming project's TypeScript setup must not affect Kitchen's loader.
    writeFileSync(path.join(root, "tsconfig.json"), '{"extends":"missing-project-config"}');
    writeFileSync(path.join(root, "docs/_templates/intent.md"), "My intent template\n");
    writeFileSync(path.join(root, ".gitignore"), "existing-rule\r\n");
    git(root, "init", "--initial-branch=trunk");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "baseline");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "update-ref", "refs/remotes/origin/trunk", base);
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    git(root, "remote", "add", "origin", "git@github.com:example/project.git");

    const init = await invokeCli(cwd, ["init", "--cwd", "target project", "--json"]);
    expect(init.code, init.stderr).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({ root, base: "origin/trunk" });
    const config = path.join(root, "kitchen.config.json");
    const configContents = readFileSync(config, "utf8");
    expect(JSON.parse(configContents)).toMatchObject({
      base: "origin/trunk", github: { repository: "example/project" }, profiles: {},
    });
    expect(readFileSync(path.join(root, "docs/_templates/intent.md"), "utf8")).toBe("My intent template\n");
    expect(readFileSync(path.join(root, "docs/_templates/spec.md"), "utf8")).toContain("Acceptance");
    const ignore = readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(ignore).toBe("existing-rule\r\n/.kitchen/\r\n/kitchen.config.local.json\r\n");
    const repeated = await invokeCli(cwd, ["init", "--cwd", root, "--json"]);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout).created).toEqual([]);
    expect(readFileSync(config, "utf8")).toBe(configContents);
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(ignore);
    expect(existsSync(path.join(root, "package.json"))).toBe(false);
    expect(existsSync(path.join(cwd, "kitchen.config.json"))).toBe(false);

    const nested = path.join(root, "requests");
    mkdirSync(nested);
    writeFileSync(path.join(nested, "request.txt"), "Use Kitchen from another project.");
    const started = await invokeCli(cwd, ["start", "portable", "--cwd", nested, "--request-file", "request.txt", "--json"]);
    expect(started.code, started.stderr).toBe(0);
    const state = JSON.parse(started.stdout) as FeatureState;
    expect(state.request).toBe("Use Kitchen from another project.");
    expect(state.baseCommit).toBe(base);
    expect(state.worktree).toBe(path.join(root, ".kitchen/worktrees/portable"));
    const summary = await invokeCli(cwd, ["status", "portable", "--cwd", root]);
    expect(summary.code, summary.stderr).toBe(0);
    expect(summary.stdout).toContain(`Next: kitchen --cwd '${root}' run portable intent`);
    const status = await invokeCli(state.worktree, ["status", "portable", "--json"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(state);
    const evaluation = await invokeCli(cwd, ["evaluate", "spec", "--cwd", root]);
    expect(evaluation.code, evaluation.stderr).toBe(0);
    expect(JSON.parse(evaluation.stdout)).toMatchObject({ measured: false, labeled: 0 });
  });

  it("explains missing Git repositories and base commits without creating config", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-empty-"));
    const missing = await invokeCli(root, ["init"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("No Git working repository");
    git(root, "init", "--initial-branch=main");
    const empty = await invokeCli(root, ["init"]);
    expect(empty.code).not.toBe(0);
    expect(empty.stderr).toContain("initial commit");
    expect(existsSync(path.join(root, "kitchen.config.json"))).toBe(false);
  });
});
