import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Kitchen } from "../src/kitchen.ts";

const documents: Record<string, string> = {
  intent:
    "# Answer\n## What the product can't do today\nReturn the required answer.\n## Who is affected\nCustomers.\n## What better looks like\nAnswer is 42.\n## Out of scope\nOther calculations.\n## Constraints\nLocal execution.\n",
  spec: "# Answer\n## Summary\nReturn 42.\n## Requirements and acceptance criteria\n| ID | Requirement | Acceptance criteria |\n|---|---|---|\n| AC-1 | Answer | Given a request, when called, then return 42. |\n## Roles and permissions\nPublic pure function.\n## Business rules and edge cases\nRepeated calls return 42.\n## Non-goals\nOther calculations.\n",
  plan: "# Plan\n## Description\nImplement the answer in the existing module.\n## Files to change\nsrc/answer.ts and src/answer.test.ts\n## Steps to implement\nWrite tests, then implement.\n## Test plan\nSee ./test-plan.md.\n## Risks\nRegression.\n",
  "test-plan":
    "# Test plan\n## Acceptance coverage\nAC-1: unit assertion.\n## Unit tests\nsrc/answer.test.ts\n## Regression\nRun the answer suite.\n## Required evidence\nRED and GREEN reports.\n",
};
const checks = [
  {
    id: "answer-unit",
    profile: "unit",
    files: ["src/answer.test.ts"],
    acIds: ["AC-1"],
    required: true,
    expectation: "red",
  },
];

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture(baselineAnswer = 0) {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-workflow-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, ".gitignore"), ".kitchen/\nnode_modules/\n");
  writeFileSync(
    path.join(root, "src/answer.ts"),
    `export const answer = ${baselineAnswer};\n`,
  );
  writeFileSync(
    path.join(root, "unit-runner.mjs"),
    `import {readFileSync} from 'node:fs';
const passed = readFileSync('src/answer.ts','utf8').includes('= 42');
console.log(JSON.stringify({numTotalTests:1,numPassedTests:passed?1:0,numFailedTests:passed?0:1,testResults:[{assertionResults:[{fullName:'AC-1 returns 42',status:passed?'passed':'failed',failureMessages:passed?[]:['AssertionError: expected 0 to be 42']}]}]}));
process.exitCode=passed?0:1;`,
  );
  writeFileSync(
    path.join(root, "kitchen.config.json"),
    JSON.stringify({
      github: { repository: "HireBus/hirebus-v3", account: "chef" },
      profiles: {
        unit: {
          cwd: ".",
          command: process.execPath,
          args: ["unit-runner.mjs"],
          kind: "unit",
          parser: "vitest-json",
          timeoutMs: 10000,
        },
      },
    }),
  );
  git(root, "init", "--initial-branch=develop");
  git(root, "config", "user.name", "Kitchen Test");
  git(root, "config", "user.email", "kitchen@example.test");
  git(root, "config", "core.autocrlf", "false");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/develop", base);
  const remote = path.join(
    mkdtempSync(path.join(tmpdir(), "kitchen-remote-")),
    "HireBus",
    "hirebus-v3.git",
  );
  mkdirSync(path.dirname(remote), { recursive: true });
  git(root, "init", "--bare", remote);
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "origin", "develop");
  const calls: Array<{ station: string; role: string; prompt: string }> = [];
  const provider = async (request: {
    station: string;
    role: string;
    prompt: string;
  }) => {
    calls.push(request);
    if (request.role === "review")
      return { summary: "Reviewed against AC-1", findings: [] };
    const output = {
      summary: "Prepared",
      questions: [] as Array<{ id: string; text: string }>,
      document: documents[request.station] ?? null,
      files: [] as Array<{
        path: string;
        content: string | null;
        action: string;
        kind: string;
      }>,
      allowedPaths: [] as string[],
      checks: [] as typeof checks,
      unitTestFiles: [] as string[],
      scaffoldFiles: [] as string[],
    };
    if (request.station === "plan")
      output.allowedPaths = ["src/answer.ts", "src/answer.test.ts"];
    if (request.station === "test-plan") {
      output.checks = checks;
      output.unitTestFiles = ["src/answer.test.ts"];
    }
    if (request.station === "unit-tests")
      output.files = [
        {
          path: "src/answer.test.ts",
          content: "// AC-1\nexpect(answer).toBe(42);\n",
          action: "write",
          kind: "test",
        },
      ];
    if (request.station === "implementation")
      output.files = [
        {
          path: "src/answer.ts",
          content: "export const answer = 42;\n",
          action: "write",
          kind: "implementation",
        },
      ];
    return output;
  };
  let created = 0;
  let pushed = 0;
  const gateway = {
    identity: async () => "chef",
    find: async () =>
      created > 0 ? "https://github.com/HireBus/hirebus-v3/pull/123" : null,
    push: async () => {
      pushed++;
    },
    create: async () => {
      created++;
      return "https://github.com/HireBus/hirebus-v3/pull/123";
    },
  };
  const kitchen = new Kitchen({ root, provider, github: gateway });
  return {
    root,
    base,
    remote,
    kitchen,
    provider,
    calls,
    gateway,
    counts: () => ({ created, pushed }),
  };
}

async function acceptDocs(kitchen: Kitchen) {
  await kitchen.start("answer", { request: "Return 42 instead of 0." });
  for (const station of ["intent", "spec", "plan", "test-plan"] as const) {
    await kitchen.run("answer", station);
    await kitchen.approve("answer", station, { actor: "chef" });
  }
}

describe("station workflow", () => {
  it("creates an isolated worktree anchored to the remote development commit", async () => {
    const { kitchen, root, base } = fixture();
    const state = await kitchen.start("answer", { request: "Return 42." });
    expect(state.worktree).not.toBe(root);
    expect(state.baseCommit).toBe(base);
    expect(git(state.worktree, "branch", "--show-current")).toBe(
      "codex/kitchen/answer",
    );
    expect(readFileSync(path.join(root, "src/answer.ts"), "utf8")).toContain(
      "= 0",
    );
  });
  it("never skips document or tests-first approvals", async () => {
    const { kitchen } = fixture();
    await kitchen.start("answer", { request: "Return 42." });
    await expect(kitchen.run("answer", "spec")).rejects.toThrow(/intent/i);
    await acceptDocsAfterStart(kitchen);
    await expect(kitchen.run("answer", "implementation")).rejects.toThrow(
      /unit-tests/i,
    );
  });
  it("does not infer acceptance from frontmatter", async () => {
    const { kitchen } = fixture();
    const state = await kitchen.start("answer", { request: "Return 42." });
    mkdirSync(path.join(state.worktree, "docs/features/answer"), {
      recursive: true,
    });
    writeFileSync(
      path.join(state.worktree, "docs/features/answer/intent.md"),
      "---\nstatus: accepted\n---\n" + documents.intent,
    );
    await expect(kitchen.run("answer", "spec")).rejects.toThrow(/intent/i);
  });
  it("persists human answers separately and asks before authoring", async () => {
    const setup = fixture();
    let questioned = false;
    const provider = async (request: {
      station: string;
      role: string;
      prompt: string;
    }) => {
      if (request.role === "author" && !questioned) {
        questioned = true;
        return {
          summary: "Need audience",
          questions: [{ id: "audience", text: "Who needs the answer?" }],
          document: null,
          files: [],
          allowedPaths: [],
          checks: [],
          unitTestFiles: [],
          scaffoldFiles: [],
        };
      }
      return setup.provider(request);
    };
    const kitchen = new Kitchen({
      root: setup.root,
      provider,
      github: setup.gateway,
    });
    await kitchen.start("answer", { request: "Return 42." });
    await kitchen.run("answer", "intent", {
      ask: async () => "Company owners",
    });
    const state = await kitchen.status("answer");
    expect(state.conversation).toContainEqual(
      expect.objectContaining({ role: "operator", text: "Company owners" }),
    );
    expect(state.stations.intent?.status).toBe("awaiting-approval");
  });
  it("marks an edited accepted artifact and its dependents stale", async () => {
    const { kitchen } = fixture();
    await acceptDocs(kitchen);
    const state = await kitchen.status("answer");
    writeFileSync(
      path.join(state.worktree, "docs/features/answer/intent.md"),
      documents.intent + "New outcome.\n",
    );
    const next = await kitchen.status("answer");
    expect(next.stations.intent?.status).toBe("stale");
    expect(next.stations["test-plan"]?.status).toBe("stale");
    await expect(kitchen.run("answer", "unit-tests")).rejects.toThrow();
  });
  it("records behavioral RED and a tests-first commit before implementation", async () => {
    const { kitchen, root } = fixture();
    await acceptDocs(kitchen);
    await kitchen.run("answer", "unit-tests");
    const red = await kitchen.status("answer");
    expect(red.stations["unit-tests"]?.checks[0]?.status).toBe("expected-red");
    await kitchen.approve("answer", "unit-tests", { actor: "chef" });
    const accepted = await kitchen.status("answer");
    expect(accepted.testsFirstCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(
      git(
        accepted.worktree,
        "show",
        `${accepted.testsFirstCommit}:src/answer.test.ts`,
      ),
    ).toContain("toBe(42)");
    expect(
      git(
        accepted.worktree,
        "show",
        `${accepted.testsFirstCommit}:src/answer.ts`,
      ),
    ).toContain("= 0");
    await kitchen.run("answer", "implementation");
    expect(readFileSync(path.join(root, "src/answer.ts"), "utf8")).toContain(
      "= 0",
    );
  });
  it("invalidates approved tests when assertions are weakened manually", async () => {
    const { kitchen } = fixture();
    await acceptDocs(kitchen);
    await kitchen.run("answer", "unit-tests");
    await kitchen.approve("answer", "unit-tests", { actor: "chef" });
    const state = await kitchen.status("answer");
    writeFileSync(
      path.join(state.worktree, "src/answer.test.ts"),
      "expect(true).toBe(true);\n",
    );
    expect(
      (await kitchen.status("answer")).stations["unit-tests"]?.status,
    ).toBe("stale");
    await expect(kitchen.run("answer", "implementation")).rejects.toThrow();
  });
  it("rejects an implementation author's attempt to rewrite approved tests before applying any file", async () => {
    const setup = fixture();
    await acceptDocs(setup.kitchen);
    await setup.kitchen.run("answer", "unit-tests");
    await setup.kitchen.approve("answer", "unit-tests", { actor: "chef" });
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) => {
        const output = await setup.provider(request);
        if (
          request.station === "implementation" &&
          request.role === "author" &&
          "files" in output
        )
          output.files.push({
            path: "src/answer.test.ts",
            content: "expect(true).toBe(true)",
            action: "write",
            kind: "test",
          });
        return output;
      },
    });
    await expect(kitchen.run("answer", "implementation")).rejects.toThrow(
      /test/i,
    );
    const state = await kitchen.status("answer");
    expect(
      readFileSync(path.join(state.worktree, "src/answer.ts"), "utf8"),
    ).toContain("= 0");
  });
  it("keeps a provider failure recoverable across process restarts", async () => {
    const setup = fixture();
    await setup.kitchen.start("answer", { request: "Return 42" });
    const broken = new Kitchen({
      root: setup.root,
      provider: async () => {
        throw new Error("provider unavailable");
      },
      github: setup.gateway,
    });
    await expect(broken.run("answer", "intent")).rejects.toThrow(
      /provider unavailable/,
    );
    expect((await setup.kitchen.status("answer")).stations.intent?.status).toBe(
      "failed",
    );
    await setup.kitchen.run("answer", "intent");
    expect((await setup.kitchen.status("answer")).stations.intent?.status).toBe(
      "awaiting-approval",
    );
  });
  it("requires GREEN and produces a reproducible report before PR publication", async () => {
    const setup = fixture();
    await acceptDocs(setup.kitchen);
    for (const station of ["unit-tests", "implementation", "verify"] as const) {
      await setup.kitchen.run("answer", station);
      await setup.kitchen.approve("answer", station, { actor: "chef" });
    }
    const report = await setup.kitchen.report("answer");
    expect(report).toContain("AC-1");
    expect(report).toContain("expected-red");
    expect(report).toContain("passed");
    const preview = await setup.kitchen.publish("answer", { preview: true });
    expect(setup.counts()).toEqual({ created: 0, pushed: 0 });
    expect(preview.body).toContain("test-plan.md");
    await setup.kitchen.approve("answer", "publish", { actor: "chef" });
    const published = await setup.kitchen.publish("answer");
    expect(published.url).toBe(
      "https://github.com/HireBus/hirebus-v3/pull/123",
    );
    await setup.kitchen.publish("answer");
    expect(setup.counts().created).toBe(1);
  });
  it("requires explicit identity and detects changed base/source before publication", async () => {
    const setup = fixture();
    await acceptDocs(setup.kitchen);
    for (const station of ["unit-tests", "implementation", "verify"] as const) {
      await setup.kitchen.run("answer", station);
      await setup.kitchen.approve("answer", station, { actor: "chef" });
    }
    await setup.kitchen.publish("answer", { preview: true });
    await setup.kitchen.approve("answer", "publish", { actor: "chef" });
    const state = await setup.kitchen.status("answer");
    writeFileSync(
      path.join(state.worktree, "src/answer.ts"),
      "export const answer = 43;\n",
    );
    await expect(setup.kitchen.publish("answer")).rejects.toThrow();
    expect(setup.counts()).toEqual({ created: 0, pushed: 0 });
  });
  it("implements accepted interface scaffolds without invalidating unit-test approval", async () => {
    const setup = fixture();
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) => {
        const output = await setup.provider(request);
        if (request.role === "author" && "files" in output) {
          if (request.station === "plan")
            output.allowedPaths.push("src/new-answer.ts");
          if (request.station === "test-plan")
            output.scaffoldFiles.push("src/new-answer.ts");
          if (request.station === "unit-tests")
            output.files.push({
              path: "src/new-answer.ts",
              action: "write",
              kind: "scaffold",
              content:
                "export function newAnswer(): number { return undefined as never; }",
            });
          if (request.station === "implementation")
            output.files.push({
              path: "src/new-answer.ts",
              action: "write",
              kind: "implementation",
              content: "export function newAnswer(): number { return 42; }",
            });
        }
        return output;
      },
    });
    await acceptDocs(kitchen);
    await kitchen.run("answer", "unit-tests");
    await kitchen.approve("answer", "unit-tests", { actor: "chef" });
    await kitchen.run("answer", "implementation");
    expect(
      (await kitchen.status("answer")).stations["unit-tests"]?.status,
    ).toBe("approved");
    await kitchen.approve("answer", "implementation", { actor: "chef" });
  });
  it("rechecks revised tests against the pinned baseline and preserves the original tests-first commit", async () => {
    const setup = fixture();
    await acceptDocs(setup.kitchen);
    await setup.kitchen.run("answer", "unit-tests");
    await setup.kitchen.approve("answer", "unit-tests", { actor: "chef" });
    const initial = (await setup.kitchen.status("answer")).testsFirstCommit;
    await setup.kitchen.run("answer", "implementation");
    await setup.kitchen.approve("answer", "implementation", { actor: "chef" });
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) => {
        const output = await setup.provider(request);
        if (
          request.role === "author" &&
          request.station === "unit-tests" &&
          "files" in output
        )
          output.files[0]!.content +=
            "// AC-1 requires the same result on repeated calls.\n";
        return output;
      },
    });
    await expect(kitchen.run("answer", "unit-tests")).rejects.toThrow(
      /explanation/i,
    );
    await kitchen.run("answer", "unit-tests", {
      feedback: "AC-1 needs explicit repeated-call coverage.",
    });
    expect(
      (await kitchen.status("answer")).stations["unit-tests"]?.checks[0]
        ?.status,
    ).toBe("expected-red");
    await kitchen.approve("answer", "unit-tests", { actor: "chef" });
    const state = await kitchen.status("answer");
    expect(state.testsFirstCommit).toBe(initial);
    expect(state.testRevisionCommits).toHaveLength(1);
    expect(state.stations.implementation?.status).toBe("stale");
  });
  it("blocks approval when required GREEN still fails", async () => {
    const setup = fixture();
    await acceptDocs(setup.kitchen);
    await setup.kitchen.run("answer", "unit-tests");
    await setup.kitchen.approve("answer", "unit-tests", { actor: "chef" });
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) => {
        const output = await setup.provider(request);
        if (
          request.role === "author" &&
          request.station === "implementation" &&
          "files" in output
        )
          output.files = [];
        return output;
      },
    });
    await kitchen.run("answer", "implementation");
    await expect(
      kitchen.approve("answer", "implementation", { actor: "chef" }),
    ).rejects.toThrow(/failures/i);
  });
  it("recovers a remotely created PR after a failed create response without duplicating it", async () => {
    const setup = fixture();
    let created = 0;
    const gateway = {
      ...setup.gateway,
      find: async () =>
        created ? "https://github.com/HireBus/hirebus-v3/pull/456" : null,
      create: async () => {
        created++;
        throw new Error("connection lost after creation");
      },
    };
    const kitchen = new Kitchen({
      root: setup.root,
      provider: setup.provider,
      github: gateway,
    });
    await acceptDocs(kitchen);
    for (const station of ["unit-tests", "implementation", "verify"] as const) {
      await kitchen.run("answer", station);
      await kitchen.approve("answer", station, { actor: "chef" });
    }
    await kitchen.publish("answer", { preview: true });
    await kitchen.approve("answer", "publish", { actor: "chef" });
    await expect(kitchen.publish("answer")).rejects.toThrow(/connection lost/);
    expect((await kitchen.publish("answer")).url).toContain("/456");
    expect(created).toBe(1);
  });
  it("detects altered executable evidence after acceptance", async () => {
    const setup = fixture();
    await acceptDocs(setup.kitchen);
    await setup.kitchen.run("answer", "unit-tests");
    await setup.kitchen.approve("answer", "unit-tests", { actor: "chef" });
    const state = await setup.kitchen.status("answer");
    writeFileSync(
      state.stations["unit-tests"]!.checks[0]!.evidence!,
      '{"status":"passed"}',
    );
    expect(
      (await setup.kitchen.status("answer")).stations["unit-tests"]?.status,
    ).toBe("stale");
  });
  it("accepts explicitly planned preservation GREEN at the baseline", async () => {
    const setup = fixture(42);
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) => {
        const output = await setup.provider(request);
        if (
          request.role === "author" &&
          request.station === "test-plan" &&
          "checks" in output
        )
          output.checks = checks.map((c) => ({ ...c, expectation: "green" }));
        return output;
      },
    });
    await acceptDocs(kitchen);
    await kitchen.run("answer", "unit-tests");
    expect(
      (await kitchen.status("answer")).stations["unit-tests"]?.checks[0]
        ?.status,
    ).toBe("passed");
    await kitchen.approve("answer", "unit-tests", { actor: "chef" });
  });
  it("blocks push URL drift, identity mismatch and base drift before any remote writes", async () => {
    const setup = fixture();
    await acceptDocs(setup.kitchen);
    for (const station of ["unit-tests", "implementation", "verify"] as const) {
      await setup.kitchen.run("answer", station);
      await setup.kitchen.approve("answer", station, { actor: "chef" });
    }
    git(setup.root, 'remote', 'set-url', '--push', 'origin', 'https://example.invalid/HireBus/hirebus-v3.git');
    await setup.kitchen.publish('answer', { preview: true });
    await setup.kitchen.approve('answer', 'publish', { actor: 'chef' });
    await expect(setup.kitchen.publish('answer')).rejects.toThrow(/origin/i);
    expect(setup.counts()).toEqual({ created: 0, pushed: 0 });
    git(setup.root, 'remote', 'set-url', '--push', 'origin', setup.remote);
    const file = path.join(setup.root, "kitchen.config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.github.account = "another-person";
    writeFileSync(file, JSON.stringify(config));
    expect((await setup.kitchen.status("answer")).stations.verify?.status).toBe(
      "approved",
    );
    await setup.kitchen.publish("answer", { preview: true });
    await setup.kitchen.approve("answer", "publish", { actor: "chef" });
    await expect(setup.kitchen.publish("answer")).rejects.toThrow(/identity/i);
    config.github.account = "chef";
    writeFileSync(file, JSON.stringify(config));
    await setup.kitchen.publish("answer", { preview: true });
    await setup.kitchen.approve("answer", "publish", { actor: "chef" });
    git(setup.root, "commit", "--allow-empty", "-m", "new base");
    git(
      setup.root,
      "update-ref",
      "refs/remotes/origin/develop",
      git(setup.root, "rev-parse", "HEAD"),
    );
    await expect(setup.kitchen.publish("answer")).rejects.toThrow(
      /base drift/i,
    );
    expect(setup.counts()).toEqual({ created: 0, pushed: 0 });
  });
});

async function acceptDocsAfterStart(kitchen: Kitchen) {
  for (const station of ["intent", "spec", "plan", "test-plan"] as const) {
    await kitchen.run("answer", station);
    await kitchen.approve("answer", station, { actor: "chef" });
  }
}
