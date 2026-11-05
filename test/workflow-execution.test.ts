import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Kitchen } from "../src/kitchen.ts";
import { checks, git, fixture, acceptDocs } from "./workflow-fixture.ts";

describe("station workflow execution", () => {
it("collects manual evidence during implementation before review and approval", async () => {
    const setup = fixture(0, { implementation: { reviewEnabled: true } });
    const configFile = path.join(setup.root, "kitchen.config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.profiles.manual = { kind: "manual" };
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(path.join(setup.root, ".gitignore"), ".kitchen/\nnode_modules/\n.local/\n");
    git(setup.root, "add", ".gitignore", "kitchen.config.json");
    git(setup.root, "commit", "-m", "Configure manual evidence");
    git(setup.root, "update-ref", "refs/remotes/origin/develop", git(setup.root, "rev-parse", "HEAD"));
    let reviewed = false;
    const kitchen = new Kitchen({
      root: setup.root,
      provider: async (request) => {
        if (request.station === "implementation" && request.role === "review") {
          expect(request.prompt).toContain("Observed the required answer in the built app.");
          reviewed = true;
        }
        const output = await setup.provider(request);
        if (request.station === "test-plan" && "checks" in output)
          output.checks = [...checks, { id: "manual-visual", profile: "manual", files: [], acIds: ["AC-1"], required: true, expectation: "green" }];
        return output;
      },
      github: setup.gateway,
    });
    await acceptDocs(kitchen);
    await kitchen.run("answer", "unit-tests");
    await kitchen.approve("answer", "unit-tests", { actor: "chef" });
    const candidate = (await kitchen.status("answer")).worktree;
    const questions: string[] = [];
    const state = await kitchen.run("answer", "implementation", {
      ask: async (question) => {
        expect(reviewed).toBe(false);
        expect(readFileSync(path.join(candidate, "src/answer.ts"), "utf8")).toContain("= 42");
        questions.push(question);
        if (questions.length === 1) return "passed: Observed the required answer in the built app.";
        mkdirSync(path.join(candidate, ".local/evidence"), { recursive: true });
        writeFileSync(path.join(candidate, ".local/evidence/answer.txt"), "Actual manual evidence");
        return ".local/evidence/answer.txt";
      },
    });
    expect(questions).toHaveLength(2);
    expect(reviewed).toBe(true);
    expect(state.stations.implementation?.checks.map(check => check.status)).toEqual(["passed", "passed"]);
    expect(state.stations.implementation?.metrics?.humanWaitMs).toBeGreaterThan(0);
    const approved = await kitchen.approve("answer", "implementation", { actor: "chef" });
    expect(approved.stations.implementation?.status).toBe("approved");
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
});
