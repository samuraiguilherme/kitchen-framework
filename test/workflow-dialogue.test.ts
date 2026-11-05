import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Kitchen } from "../src/kitchen.ts";
import { documents, fixture } from "./workflow-fixture.ts";

describe("station workflow dialogue", () => {
it.each([null, "Unresolved draft; not ready for review."])(
    "requires question-only intent responses before asking for human answers (draft: %s)",
    async (draft) => {
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
            document: draft,
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
      const started = await kitchen.start("answer", { request: "Return 42." });
      const document = path.join(
        started.worktree,
        "docs/features/answer/intent.md",
      );
      if (draft !== null) {
        let asked = false;
        await expect(kitchen.run("answer", "intent", {
          ask: async () => { asked = true; return "Company owners"; },
        })).rejects.toThrow(/Invalid intent author output/);
        expect(asked).toBe(false);
        expect(existsSync(document)).toBe(false);
        return;
      }
      await kitchen.run("answer", "intent", {
        ask: async () => {
          expect(existsSync(document)).toBe(false);
          return "Company owners";
        },
      });
      const state = await kitchen.status("answer");
      expect(state.conversation).toContainEqual(
        expect.objectContaining({ role: "operator", text: "Company owners" }),
      );
      expect(state.stations.intent?.status).toBe("awaiting-approval");
      expect(readFileSync(document, "utf8")).toBe(documents.intent);
      expect(setup.calls.map((call) => call.role)).toEqual(["author"]);
    },
  );

it("resumes saved questions before calling the author and keeps partial answers", async () => {
    const setup = fixture();
    writeFileSync(path.join(setup.root, "kitchen.config.local.json"), JSON.stringify({ providers: { author: { provider: "claude" } } }));
    const questions = [
      { id: "audience", text: "Who needs the answer?" },
      { id: "outcome", text: "What outcome do they need?" },
    ];
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) => {
        const output = await setup.provider(request);
        if (request.role === "author" && setup.calls.length === 1)
          return { ...output, questions, document: null };
        return output;
      },
    });
    await kitchen.start("answer", { request: "Return 42." });
    const pending = await kitchen.run("answer", "intent");
    const runId = pending.stations.intent?.runId;
    const unchanged = await kitchen.run("answer", "intent");
    expect(unchanged.stations.intent?.runId).toBe(runId);
    expect(setup.calls.map((call) => call.role)).toEqual(["author"]);

    await expect(
      kitchen.run("answer", "intent", {
        ask: async (question) => {
          expect(setup.calls).toHaveLength(1);
          if (question === questions[0]!.text) return "Company owners";
          throw new Error("Interrupted while answering");
        },
      }),
    ).rejects.toThrow("Interrupted while answering");
    const interrupted = await kitchen.status("answer");
    expect(interrupted.stations.intent?.status).toBe("awaiting-input");
    expect(interrupted.stations.intent?.output?.questions).toEqual([
      questions[1],
    ]);
    expect(interrupted.conversation).toContainEqual(
      expect.objectContaining({ role: "operator", text: "Company owners" }),
    );

    const asked: string[] = [];
    const resumed = await kitchen.run("answer", "intent", {
      ask: async (question) => {
        expect(setup.calls).toHaveLength(1);
        asked.push(question);
        return "Return 42";
      },
    });
    expect(asked).toEqual([questions[1]!.text]);
    expect(resumed.stations.intent?.status).toBe("awaiting-approval");
    expect(setup.calls.map((call) => call.role)).toEqual(["author", "author"]);
    expect(setup.calls[1]?.prompt).toContain("Company owners");
    expect(setup.calls[1]?.prompt).toContain('"text":"Return 42"');
    expect(
      resumed.conversation.filter((entry) => entry.role === "model"),
    ).toHaveLength(2);
  });

it("keeps feedback answers when the author requests further input", async () => {
    const setup = fixture();
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) => {
        const output = await setup.provider(request);
        return {
          ...output,
          document: null,
          questions: [{ id: "policy", text: "Which billing policy applies?" }],
        };
      },
    });
    await kitchen.start("answer", { request: "Return 42." });
    const state = await kitchen.run("answer", "intent", {
      feedback: "Company owners need to see the answer.",
    });
    expect(state.stations.intent?.status).toBe("awaiting-input");
    expect((await kitchen.status("answer")).conversation).toContainEqual(
      expect.objectContaining({
        role: "operator",
        text: "Company owners need to see the answer.",
      }),
    );
  });

it("keeps further intent questions pending after guided answers", async () => {
    const setup = fixture();
    let authorCalls = 0;
    const provider = async (request: {
      station: string;
      role: string;
      prompt: string;
    }) => {
      if (request.role === "author") {
        authorCalls++;
        return {
          ...(await setup.provider(request)),
          questions: [
            authorCalls === 1
              ? { id: "audience", text: "Who needs the answer?" }
              : { id: "outcome", text: "What outcome do they need?" },
          ],
          document: null,
          files: [],
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
    const asked: string[] = [];
    await kitchen.run("answer", "intent", {
      ask: async (question) => {
        asked.push(question);
        return "Company owners";
      },
    });
    const state = await kitchen.status("answer");
    expect(state.stations.intent?.status).toBe("awaiting-input");
    expect(state.stations.intent?.output?.questions).toEqual([
      { id: "outcome", text: "What outcome do they need?" },
    ]);
    expect(state.conversation.slice(1)).toEqual([
      expect.objectContaining({ role: "model", text: "Who needs the answer?" }),
      expect.objectContaining({ role: "operator", text: "Company owners" }),
      expect.objectContaining({
        role: "model",
        text: "What outcome do they need?",
      }),
    ]);
    expect(asked).toEqual(["Who needs the answer?"]);
    expect(
      existsSync(path.join(state.worktree, "docs/features/answer/intent.md")),
    ).toBe(false);
    expect(
      readFileSync(path.join(state.worktree, "src/answer.ts"), "utf8"),
    ).toBe("export const answer = 0;\n");
    expect(setup.calls.map((call) => call.role)).toEqual(["author", "author"]);
  });
});
