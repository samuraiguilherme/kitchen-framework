import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runFileProposals } from "../src/file-proposals.ts";
import { sourceFingerprint } from "../src/git.ts";
import { Kitchen } from "../src/kitchen.ts";
import type { Config, FileProposal, ProposalGroups } from "../src/types.ts";
import { acceptDocs, checks, fixture, git } from "./workflow-fixture.ts";

describe("file proposal pilot", () => {
  it("joins ownership order after both workers finish and keeps RED, GREEN, and approval gates", async () => {
    const tests = ["src/answer.test.mjs", "src/bonus.test.mjs"];
    const modules = ["src/answer.mjs", "src/bonus.mjs"];
    const names = ["answer", "bonus"];
    const setup = fixture(0, {
      "unit-tests": { proposalGroups: { answer: [[tests[0]!], [tests[1]!]] } },
      implementation: { proposalGroups: { answer: [[modules[0]!], [modules[1]!]] }, reviewEnabled: true },
    });
    const content = (index: number, value: number) => `export function ${names[index]}() { return ${value}; }\n`;
    for (const [index, file] of modules.entries()) writeFileSync(path.join(setup.root, file), content(index, 0));
    const configFile = path.join(setup.root, "kitchen.config.json");
    const config: Config = JSON.parse(readFileSync(configFile, "utf8"));
    config.profiles.unit!.args = ["unit-runner.mjs", "{files}"];
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(path.join(setup.root, "unit-runner.mjs"), `
import { pathToFileURL } from 'node:url';
let failure;
try { await import(pathToFileURL(process.argv[2]).href); }
catch (error) { failure = String(error.stack ?? error); }
const passed = !failure;
console.log(JSON.stringify({numTotalTests:1,numPassedTests:passed?1:0,numFailedTests:passed?0:1,
  testResults:[{assertionResults:[{fullName:'AC-1 returns 42',status:passed?'passed':'failed',failureMessages:failure?[failure]:[]}]}]}));
process.exitCode = passed ? 0 : 1;
`);
    git(setup.root, "add", "src", "kitchen.config.json", "unit-runner.mjs");
    git(setup.root, "commit", "-m", "Seed independent modules and executable unit fixture");
    git(setup.root, "update-ref", "refs/remotes/origin/develop", git(setup.root, "rev-parse", "HEAD"));

    let mode: "missing" | "question" | "rewrite" | "valid" = "missing";
    let active = 0;
    let maximum = 0;
    const completed: number[] = [];
    const kitchen = new Kitchen({ root: setup.root, github: setup.gateway, provider: async request => {
      if (request.kind === "proposal") {
        const index = path.basename(request.runDir) === "group-1" ? 0 : 1;
        const unit = request.station === "unit-tests";
        const file = (unit ? tests : modules)[index]!;
        expect(request.prompt).toContain(`Your assigned paths: ${JSON.stringify([file])}`);
        maximum = Math.max(maximum, ++active);
        if (index === 0) await new Promise<void>(resolve => setImmediate(resolve));
        active--;
        completed.push(index);
        const response: FileProposal = {
          summary: names[index]!,
          questions: mode === "question" && index === 1 ? [{ id: "contract", text: "Does the bonus also return 42?" }] : [],
          files: mode === "missing" && index === 1 ? [] : [{
            path: mode === "rewrite" && index === 1 ? tests[0]! : file,
            action: "write",
            kind: unit ? "test" : "implementation",
            content: unit
              ? `import assert from 'node:assert/strict';\nimport { ${names[index]} } from './${names[index]}.mjs';\nassert.equal(${names[index]}(), 42);\n`
              : content(index, 42),
          }],
        };
        return response;
      }
      if (request.station === "implementation" && request.role === "review") {
        expect(active).toBe(0);
        for (const [index, file] of modules.entries()) expect(readFileSync(path.join(request.cwd, file), "utf8")).toBe(content(index, 42));
        expect(request.prompt).toContain('"status":"passed"');
      }
      const output = await setup.provider(request);
      if (request.station === "plan" && "allowedPaths" in output) output.allowedPaths = [...modules, ...tests];
      if (request.station === "test-plan" && "checks" in output) {
        output.unitTestFiles = tests;
        output.checks = tests.map((file, index) => ({ ...checks[0]!, id: `${names[index]}-unit`, files: [file] }));
      }
      return output;
    } });
    await acceptDocs(kitchen);
    const { worktree } = await kitchen.status("answer");
    await expect(kitchen.run("answer", "implementation")).rejects.toThrow("Approve unit-tests");
    await expect(kitchen.run("answer", "unit-tests")).rejects.toThrow("Missing approved unit test files");
    expect(tests.some(file => existsSync(path.join(worktree, file)))).toBe(false);

    mode = "question";
    const waiting = await kitchen.run("answer", "unit-tests");
    expect(waiting.stations["unit-tests"]).toMatchObject({ status: "awaiting-input", output: { files: [], questions: [expect.objectContaining({ text: "Does the bonus also return 42?" })] }, checks: [] });
    expect(tests.some(file => existsSync(path.join(worktree, file)))).toBe(false);

    mode = "valid";
    completed.length = 0;
    const red = await kitchen.run("answer", "unit-tests", { feedback: "Yes, both return 42." });
    expect(completed).toEqual([1, 0]);
    expect(maximum).toBe(2);
    expect(red.stations["unit-tests"]?.output?.files.map(file => file.path)).toEqual(tests);
    expect(red.stations["unit-tests"]?.checks.map(check => check.status)).toEqual(["expected-red", "expected-red"]);
    expect(red.testsFirstCommit).toBeUndefined();
    await expect(kitchen.run("answer", "implementation")).rejects.toThrow("Approve unit-tests");
    const checkpoint = await kitchen.approve("answer", "unit-tests", { actor: "chef" });
    for (const [index, file] of modules.entries())
      expect(git(worktree, "show", `${checkpoint.testsFirstCommit}:${file}`)).toBe(content(index, 0).trim());
    const acceptedTests = tests.map(file => readFileSync(path.join(worktree, file), "utf8"));

    mode = "rewrite";
    await expect(kitchen.run("answer", "implementation")).rejects.toThrow(`does not own ${tests[0]}`);
    expect(modules.map(file => readFileSync(path.join(worktree, file), "utf8"))).toEqual(modules.map((_, index) => content(index, 0)));
    mode = "valid";
    const green = await kitchen.run("answer", "implementation");
    expect(green.stations.implementation?.output?.files.map(file => file.path)).toEqual(modules);
    expect(green.stations.implementation?.checks.map(check => check.status)).toEqual(["passed", "passed"]);
    expect(tests.map(file => readFileSync(path.join(worktree, file), "utf8"))).toEqual(acceptedTests);
    await expect(kitchen.run("answer", "verify")).rejects.toThrow("Approve implementation");
    await kitchen.approve("answer", "implementation", { actor: "chef" });
    expect((await kitchen.run("answer", "verify")).stations.verify?.checks.map(check => check.status)).toEqual(["passed", "passed"]);
  });

  it.each([
    [["src/Case.ts"], ["src/case.ts"]],
    [["src/path"], ["src/path/child.ts"]],
  ] as const)("rejects overlapping destinations before calling workers: %j and %j", async (first, second) => {
    const setup = fixture();
    const groups: ProposalGroups = [first, second];
    await expect(runFileProposals({
      station: "implementation", worktree: setup.root, feature: "answer", groups,
      eligible: groups.flat(), protectedPaths: [], source: await sourceFingerprint(setup.root, "answer"),
      prompt: "Draft", provider: async () => { throw new Error("Worker started"); },
      config: { provider: "codex" }, timeoutMs: 1000, runDir: path.join(setup.root, ".kitchen/proposals"),
    })).rejects.toThrow("Conflicting proposal paths");
  });

  it("rejects a worker source edit before returning a joined candidate", async () => {
    const setup = fixture();
    const groups = [["src/first.ts"], ["src/second.ts"]] as const;
    await expect(runFileProposals({
      station: "implementation", worktree: setup.root, feature: "answer", groups,
      eligible: groups.flat(), protectedPaths: [], source: await sourceFingerprint(setup.root, "answer"),
      prompt: "Draft", provider: async request => {
        if (request.prompt.includes("FILE PROPOSAL GROUP 1")) writeFileSync(path.join(request.cwd, "src/answer.ts"), "changed");
        return { summary: "Unchanged", questions: [], files: [] };
      },
      config: { provider: "codex" }, timeoutMs: 1000, runDir: path.join(setup.root, ".kitchen/proposals"),
    })).rejects.toThrow("Proposal provider changed repository contents");
    expect(existsSync(path.join(setup.root, ".kitchen/proposals/validated-output.json"))).toBe(false);
  });
});
