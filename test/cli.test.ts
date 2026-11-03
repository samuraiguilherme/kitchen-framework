import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
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
  it("prints DSH, Ollama, model pin and structured-probe readiness through kitchen doctor", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen doctor cli "));
    git(root, "init", "--initial-branch=main");
    git(
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "baseline",
    );
    const fixtureBin = path.join(root, "fixture bin");
    mkdirSync(fixtureBin);
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          models: [{ name: "local-deepseek", digest: "a".repeat(64) }],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing fixture address");
      const script = path.join(fixtureBin, "npx.mjs");
      writeFileSync(
        script,
        [
          "if(process.argv.includes('--version')) { console.log('0.2.2-alpha.3'); process.exit(0); }",
          "for await(const chunk of process.stdin) {}",
          "console.log(JSON.stringify({type:'session',sessionId:'doctor-cli'}));",
          "console.log(JSON.stringify({type:'final',sessionId:'doctor-cli',reason:{kind:'completed'},text:JSON.stringify({summary:'Kitchen model probe OK',questions:[],document:null,files:[],allowedPaths:[],unitTestFiles:[],scaffoldFiles:[],checks:[]})}));",
        ].join("\n"),
      );
      const launcher = path.join(
        fixtureBin,
        process.platform === "win32" ? "fake-npx.cmd" : "fake-npx",
      );
      writeFileSync(
        launcher,
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(fixtureBin, process.platform === "win32" ? "gh.cmd" : "gh"),
        process.platform === "win32"
          ? "@echo off\r\nexit /b 1\r\n"
          : "#!/bin/sh\nexit 1\n",
        { mode: 0o755 },
      );
      const claudeScript = path.join(fixtureBin, "claude.mjs");
      const claudeLog = path.join(fixtureBin, "claude-calls.jsonl");
      writeFileSync(claudeScript, [
        "import fs from 'node:fs';",
        `fs.appendFileSync(${JSON.stringify(claudeLog)},JSON.stringify(process.argv.slice(2))+'\\n');`,
        "console.log(process.argv.includes('auth') ? JSON.stringify({loggedIn:true}) : 'Claude fixture');",
      ].join("\n"));
      const claudeLauncher = path.join(fixtureBin, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude");
      writeFileSync(claudeLauncher, process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${claudeScript}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${claudeScript}" "$@"\n`, { mode: 0o755 });
      writeFileSync(
        path.join(root, "kitchen.config.json"),
        JSON.stringify({
          base: "main",
          providers: {
            review: { provider: "claude", model: "configured-claude-review", executable: claudeLauncher },
            author: {
              provider: "deepseek",
              executable: launcher,
              model: "local-deepseek",
              dsh: {
                version: "0.2.2-alpha.3",
                baseURL: `http://127.0.0.1:${address.port}/v1`,
                contextWindow: 8192,
                maxTokens: 2048,
                expectedModelDigest: "a".repeat(64),
              },
            },
          },
        }),
      );
      const result = await runProcess({
        command: process.execPath,
        args: [bin, "doctor", "--cwd", root],
        cwd: root,
        timeoutMs: 15000,
        env: { PATH: fixtureBin + path.delimiter + process.env.PATH },
      });
      expect(result.code, [result.stderr, result.stdout].join("\n")).toBe(0);
      const checks = JSON.parse(result.stdout) as Array<{
        id: string;
        status: string;
        required: boolean;
        reason: string;
      }>;
      for (const id of [
        "deepseek-configuration",
        "dsh-cli",
        "deepseek-node",
        "ollama-server",
        "deepseek-local",
        "deepseek-model-1",
      ])
        expect(
          checks.find((check) => check.id === id),
          id,
        ).toMatchObject({ status: "passed", required: true });
      expect(
        checks.find((check) => check.id === "deepseek-local")?.reason,
      ).toContain("pin=matched");
      expect(checks.some(check => check.id.startsWith("codex-"))).toBe(false);
      expect(checks.find(check => check.id === "claude-configuration")).toMatchObject({
        required: false, status: "unverified", reason: expect.stringContaining("configured-claude-review"),
      });
      for (const id of ["claude-cli", "claude-auth"])
        expect(checks.find(check => check.id === id)).toMatchObject({ required: false, status: "passed" });
      const claudeCalls = readFileSync(claudeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(claudeCalls).toEqual(expect.arrayContaining([["--version"], ["auth", "status", "--json"]]));
      expect(claudeCalls).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
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

  it("selects author/reviewer on init and rejects runtime role flags", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-roles-"));
    git(root, "init", "--initial-branch=main");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "baseline");
    const invalid = await invokeCli(root, ["init", "--author", "unknown"]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("codex or claude");
    expect(existsSync(path.join(root, "kitchen.config.json"))).toBe(false);
    const result = await invokeCli(root, ["init", "--author", "claude", "--review", "codex", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ author: "claude", review: "codex" });
    const repeated = await invokeCli(root, ["init"]);
    expect(repeated.stdout).toContain("Author: claude; reviewer: codex");
    for (const role of ["author", "review"]) {
      const rejected = await invokeCli(root, ["status", "answer", `--${role}`, "claude"]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain(`--${role} is only supported by kitchen init`);
    }
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
