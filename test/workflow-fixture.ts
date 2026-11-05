import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Kitchen } from "../src/kitchen.ts";
import type { Config, PrInput, RoleConfig } from "../src/types.ts";

export const documents: Record<string, string> = {
  intent:
    "# Answer\n## What the product can't do today\nReturn the required answer.\n## Who is affected\nCustomers.\n## What better looks like\nAnswer is 42.\n## Out of scope\nOther calculations.\n## Constraints\nLocal execution.\n",
  spec: "# Answer\n## Summary\nReturn 42.\n## Requirements and acceptance criteria\n| ID | Requirement | Acceptance criteria |\n|---|---|---|\n| AC-1 | Answer | Given a request, when called, then return 42. |\n## Roles and permissions\nPublic pure function.\n## Business rules and edge cases\nRepeated calls return 42.\n## Non-goals\nOther calculations.\n",
  plan: "# Plan\n## Description\nImplement the answer in the existing module.\n## Files to change\nsrc/answer.ts and src/answer.test.ts\n## Steps to implement\nWrite tests, then implement.\n## Test plan\nSee ./test-plan.md.\n## Risks\nRegression.\n",
  "test-plan":
    "# Test plan\n## Acceptance coverage\nAC-1: unit assertion.\n## Unit tests\nsrc/answer.test.ts\n## Regression\nRun the answer suite.\n## Required evidence\nRED and GREEN reports.\n",
};

export const checks = [
  {
    id: "answer-unit",
    profile: "unit",
    files: ["src/answer.test.ts"],
    acIds: ["AC-1"],
    required: true,
    expectation: "red",
  },
];

export function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function fixture(baselineAnswer = 0, stations: Config["stations"] = {}, baseBranch = "develop") {
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
      base: `origin/${baseBranch}`,
      github: { repository: "example/project", account: "chef" },
      stations,
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
  git(root, "init", `--initial-branch=${baseBranch}`);
  git(root, "config", "user.name", "Kitchen Test");
  git(root, "config", "user.email", "kitchen@example.test");
  git(root, "config", "core.autocrlf", "false");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", `refs/remotes/origin/${baseBranch}`, base);
  const remote = path.join(
    mkdtempSync(path.join(tmpdir(), "kitchen-remote-")),
    "example",
    "project.git",
  );
  mkdirSync(path.dirname(remote), { recursive: true });
  git(root, "init", "--bare", remote);
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "origin", baseBranch);
  const calls: Array<{ station: string; role: string; prompt: string; config?: RoleConfig }> = [];
  const provider = async (request: {
    station: string;
    role: string;
    prompt: string;
    config?: RoleConfig;
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
  const publications: PrInput[] = [];
  const gateway = {
    identity: async () => "chef",
    find: async () =>
      created > 0 ? "https://github.com/example/project/pull/123" : null,
    push: async () => {
      pushed++;
    },
    create: async (input: PrInput) => {
      created++;
      publications.push(input);
      return "https://github.com/example/project/pull/123";
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
    publications,
    counts: () => ({ created, pushed }),
  };
}

export async function acceptDocs(kitchen: Kitchen) {
  await kitchen.start("answer", { request: "Return 42 instead of 0." });
  for (const station of ["intent", "spec", "plan", "test-plan"] as const) {
    await kitchen.run("answer", station);
    await kitchen.approve("answer", station, { actor: "chef" });
  }
}

export async function preparedFixture(setupCode = 0) {
  const setup = fixture();
  const configFile = path.join(setup.root, "kitchen.config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.profiles.unit.setup = {
    command: "pnpm",
    args: ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    timeoutMs: 10000,
  };
  config.profiles.architecture = {
    command: process.execPath,
    args: ["packages/example/scripts/check-architecture.mjs"],
    kind: "command",
    parser: "exit-code",
    timeoutMs: 10000,
  };
  writeFileSync(configFile, JSON.stringify(config));
  const files = [
    "package.json",
    "pnpm-lock.yaml",
    "packages/example/package.json",
    "packages/example/scripts/check-architecture.mjs",
  ];
  const kitchen = new Kitchen({
    root: setup.root,
    github: setup.gateway,
    provider: async (request) => {
      const output = await setup.provider(request);
      if (request.role === "author" && "files" in output) {
        if (request.station === "plan") output.allowedPaths.push(...files);
        if (request.station === "test-plan") {
          // Old accepted manifests used scaffoldFiles for runtime support.
          output.scaffoldFiles = files;
          output.checks = [
            ...checks,
            {
              id: "k-architecture",
              profile: "architecture",
              files: [],
              acIds: ["AC-1"],
              required: true,
              expectation: "green",
            },
          ];
        }
        if (
          request.station === "unit-tests" &&
          !request.prompt.includes('"status":"passed"')
        )
          return {
            ...output,
            files: [],
            questions: [
              {
                id: "preparation",
                text: "Which runner preparation artifact supplies the runtime fix?",
              },
            ],
          };
      }
      return output;
    },
  });
  await acceptDocs(kitchen);
  const state = await kitchen.status("answer");
  writeFileSync(
    path.join(state.worktree, "package.json"),
    JSON.stringify({
      name: "kitchen-offline-fixture",
      private: true,
      packageManager: "pnpm@9.15.9",
      ...(setupCode
        ? { dependencies: { "missing-offline-fixture": "0.0.0" } }
        : {}),
    }),
  );
  writeFileSync(
    path.join(state.worktree, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
  );
  mkdirSync(path.join(state.worktree, "packages/example/scripts"), {
    recursive: true,
  });
  writeFileSync(
    path.join(state.worktree, "packages/example/package.json"),
    '{"name":"example","version":"1.0.0"}\n',
  );
  writeFileSync(
    path.join(
      state.worktree,
      "packages/example/scripts/check-architecture.mjs",
    ),
    "import {readFileSync} from 'node:fs'; JSON.parse(readFileSync('packages/example/package.json')); console.log('architecture GREEN');\n",
  );
  const request = {
    reason: "Previously approved runtime fix",
    files,
    setupProfiles: ["unit"],
    checks: ["k-architecture"],
  };
  return { ...setup, kitchen, files, request, state };
}

export async function acceptDocsAfterStart(kitchen: Kitchen) {
  for (const station of ["intent", "spec", "plan", "test-plan"] as const) {
    await kitchen.run("answer", station);
    await kitchen.approve("answer", station, { actor: "chef" });
  }
}
