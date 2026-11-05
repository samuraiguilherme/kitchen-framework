import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Kitchen } from "../src/kitchen.ts";
import { documents, checks, fixture, acceptDocs } from "./workflow-fixture.ts";

describe("station workflow documents", () => {
it("normalizes generated check IDs in the document, manifest, review and execution", async () => {
    const setup = fixture(0, { "test-plan": { reviewEnabled: true } });
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) => {
        const output = await setup.provider(request);
        if (
          request.role === "author" &&
          request.station === "test-plan" &&
          "checks" in output
        ) {
          output.checks = checks.map((check) => ({
            ...check,
            id: "K-answer-unit",
          }));
          output.document = output.document!.replace(
            "AC-1: unit assertion.",
            "AC-1: `K-answer-unit` unit assertion.",
          );
        }
        return output;
      },
    });

    await acceptDocs(kitchen);
    const state = await kitchen.status("answer");
    const record = state.stations["test-plan"]!;
    expect(record.findings).toEqual([]);
    expect(record.output?.checks[0]?.id).toBe("k-answer-unit");
    expect(record.output?.document).toContain("`k-answer-unit`");
    const document = readFileSync(
      path.join(state.worktree, "docs/features/answer/test-plan.md"),
      "utf8",
    );
    expect(document).toContain('"id": "k-answer-unit"');
    expect(document).not.toContain("K-answer-unit");
    const authorPrompt = setup.calls.find(
      (call) => call.station === "test-plan" && call.role === "author",
    )!.prompt;
    expect(authorPrompt).toContain("## Regression");
    expect(authorPrompt).toContain("## Required evidence");
    const reviewPrompt = setup.calls.find(
      (call) => call.station === "test-plan" && call.role === "review",
    )!.prompt;
    expect(reviewPrompt).toContain('"id": "k-answer-unit"');

    const tested = await kitchen.run("answer", "unit-tests");
    expect(tested.stations["unit-tests"]?.checks[0]).toMatchObject({
      id: "k-answer-unit",
      status: "expected-red",
    });
  });

it("rejects intent questions bundled with a draft or implementation proposal before applying changes", async () => {
    const setup = fixture(0, { intent: { reviewEnabled: true } });
    let questioned = false;
    const provider = async (request: {
      station: string;
      role: string;
      prompt: string;
    }) => {
      if (request.role === "author" && !questioned) {
        questioned = true;
        return {
          ...(await setup.provider(request)),
          questions: [{ id: "audience", text: "Who needs the answer?" }],
          document: "Unresolved draft; not ready for review.",
          files: [
            {
              path: "src/answer.ts",
              action: "delete",
              content: null,
              kind: "implementation",
            },
          ],
        };
      }
      return setup.provider(request);
    };
    const kitchen = new Kitchen({
      root: setup.root,
      provider,
      github: setup.gateway,
    });
    const started = await kitchen.start("answer", { request: "Return 42." });
    const document = path.join(
      started.worktree,
      "docs/features/answer/intent.md",
    );
    mkdirSync(path.dirname(document), { recursive: true });
    writeFileSync(document, documents.intent!);

    await expect(kitchen.run("answer", "intent")).rejects.toThrow(/Invalid intent author output/);
    const state = await kitchen.status("answer");
    expect(state.stations.intent?.status).toBe("failed");
    expect(state.stations.intent?.output).toBeUndefined();
    expect(readFileSync(document, "utf8")).toBe(documents.intent);
    expect(
      readFileSync(path.join(state.worktree, "src/answer.ts"), "utf8"),
    ).toBe("export const answer = 0;\n");
    expect(setup.calls.map((call) => call.role)).toEqual(["author"]);

    const next = await kitchen.run("answer", "intent", {
      feedback: "Company owners",
    });
    expect(next.stations.intent?.status).toBe("awaiting-approval");
    expect(next.conversation).toContainEqual(
      expect.objectContaining({ role: "operator", text: "Company owners" }),
    );
    expect(setup.calls[1]?.prompt).toContain(
      "Human revision request:\nCompany owners",
    );
    expect(setup.calls.map((call) => call.role)).toEqual([
      "author",
      "author",
      "review",
    ]);
  });

it("rejects a custom provider's spec implementation proposal before applying or reviewing it", async () => {
    const setup = fixture(0, { spec: { reviewEnabled: true } });
    await setup.kitchen.start("answer", { request: "Return 42." });
    await setup.kitchen.run("answer", "intent");
    await setup.kitchen.approve("answer", "intent", { actor: "chef" });
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) => ({
        ...(await setup.provider(request)), document: null,
        files: [{ path: "src/answer.ts", action: "write", content: "export const answer = 42;\n", kind: "implementation" }],
      }),
    });
    await expect(kitchen.run("answer", "spec")).rejects.toThrow(/Invalid spec author output/);
    const state = await kitchen.status("answer");
    expect(state.stations.spec?.status).toBe("failed");
    expect(state.stations.spec?.output).toBeUndefined();
    expect(state.stations.spec?.artifactFiles).toEqual([]);
    expect(existsSync(path.join(state.worktree, "docs/features/answer/spec.md"))).toBe(false);
    expect(readFileSync(path.join(state.worktree, "src/answer.ts"), "utf8")).toBe("export const answer = 0;\n");
    expect(setup.calls.map(({ station, role }) => [station, role])).toEqual([
      ["intent", "author"], ["spec", "author"],
    ]);
  });
});
