import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Kitchen } from "../src/kitchen.ts";
import { documents, git, fixture, acceptDocs, acceptDocsAfterStart } from "./workflow-fixture.ts";

describe("station workflow approval", () => {
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

it("commits each document on approval in the feature branch", async () => {
    const { kitchen, root, base, calls } = fixture();
    const started = await kitchen.start("answer", { request: "Return 42." });
    let previousCommit = base;
    for (const station of ["intent", "spec", "plan", "test-plan"] as const) {
      const file = `docs/features/answer/${station}.md`;
      const draft = await kitchen.run("answer", station);
      expect(draft.stations[station]?.status).toBe("awaiting-approval");
      expect(draft.stations[station]?.commit).toBeUndefined();
      expect(
        calls
          .filter((call) => call.station === station)
          .map((call) => call.role),
      ).toEqual(["author"]);
      if (station === "intent") {
        expect(draft.stations.intent?.summary).toBe("Prepared");
        await expect(kitchen.run("answer", "spec")).rejects.toThrow(/intent/i);
      }
      expect(git(started.worktree, "rev-parse", "HEAD")).toBe(previousCommit);
      expect(existsSync(path.join(started.worktree, file))).toBe(true);

      const approved = await kitchen.approve("answer", station, {
        actor: "chef",
      });
      const commit = approved.stations[station]?.commit;
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(commit).not.toBe(previousCommit);
      expect(git(started.worktree, "rev-parse", "HEAD")).toBe(commit);
      expect(
        git(started.worktree, "show", "--format=", "--name-only", commit!),
      ).toBe(file);
      expect(git(started.worktree, "show", `${commit}:${file}`)).toBe(
        readFileSync(path.join(started.worktree, file), "utf8").trim(),
      );
      expect(git(started.worktree, "status", "--porcelain", "--", file)).toBe(
        "",
      );
      expect(git(root, "rev-parse", "HEAD")).toBe(base);
      expect(existsSync(path.join(root, file))).toBe(false);
      previousCommit = commit!;
    }
    const state = await kitchen.status("answer");
    expect(
      Object.values(state.stations).every((r) => r?.status === "approved"),
    ).toBe(true);
  });

it("leaves a document unapproved when unrelated files are staged", async () => {
    const { kitchen, base } = fixture();
    const state = await kitchen.start("answer", { request: "Return 42." });
    await kitchen.run("answer", "intent");
    writeFileSync(
      path.join(state.worktree, "src/answer.ts"),
      "export const answer = 1;\n",
    );
    git(state.worktree, "add", "src/answer.ts");

    await expect(
      kitchen.approve("answer", "intent", { actor: "chef" }),
    ).rejects.toThrow(/unrelated staged changes/i);
    const next = await kitchen.status("answer");
    expect(next.stations.intent?.status).toBe("awaiting-approval");
    expect(next.stations.intent?.commit).toBeUndefined();
    expect(git(state.worktree, "rev-parse", "HEAD")).toBe(base);
    expect(git(state.worktree, "diff", "--cached", "--name-only")).toBe(
      "src/answer.ts",
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

it("requires a new run when review is enabled before or after approval", async () => {
    const setup = fixture(0, { intent: { reviewEnabled: false } });
    await setup.kitchen.start("answer", { request: "Return 42." });
    await setup.kitchen.run("answer", "intent");
    const file = path.join(setup.root, "kitchen.config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.stations.intent.reviewEnabled = true;
    writeFileSync(file, JSON.stringify(config));
    await expect(
      setup.kitchen.approve("answer", "intent", { actor: "chef" }),
    ).rejects.toThrow(/changed since validation/);
    await setup.kitchen.run("answer", "intent");
    expect(setup.calls.map((call) => call.role)).toEqual([
      "author",
      "author",
      "review",
    ]);
    await setup.kitchen.approve("answer", "intent", { actor: "chef" });
    await setup.kitchen.run("answer", "spec");
    await setup.kitchen.approve("answer", "spec", { actor: "chef" });
    config.stations.spec = { reviewEnabled: true };
    writeFileSync(file, JSON.stringify(config));
    const state = await setup.kitchen.status("answer");
    expect(state.stations.intent?.status).toBe("approved");
    expect(state.stations.spec?.status).toBe("stale");
  });

it("binds inherited provider settings even when only a review flag is configured", async () => {
    const setup = fixture(0, { intent: { reviewEnabled: false } });
    await setup.kitchen.start("answer", { request: "Return 42." });
    await setup.kitchen.run("answer", "intent");
    await setup.kitchen.approve("answer", "intent", { actor: "chef" });
    const file = path.join(setup.root, "kitchen.config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.providers = { author: { provider: "codex", model: "new-model" } };
    writeFileSync(file, JSON.stringify(config));
    expect((await setup.kitchen.status("answer")).stations.intent?.status).toBe(
      "stale",
    );
  });

it("invalidates approvals when switching between Claude and Codex authors", async () => {
    const setup = fixture();
    const file = path.join(setup.root, "kitchen.config.local.json");
    writeFileSync(file, JSON.stringify({ providers: { author: { provider: "claude" } } }));
    await setup.kitchen.start("answer", { request: "Return 42." });
    await setup.kitchen.run("answer", "intent");
    await setup.kitchen.approve("answer", "intent", { actor: "chef" });
    expect(setup.calls[0]?.config?.provider).toBe("claude");
    writeFileSync(file, JSON.stringify({ providers: { author: { provider: "codex" } } }));
    expect((await setup.kitchen.status("answer")).stations.intent?.status).toBe("stale");
  });

it("uses an explicit station author instead of the global Claude role", async () => {
    const setup = fixture(0, { spec: { author: { provider: "codex", model: "spec-author" } } });
    writeFileSync(path.join(setup.root, "kitchen.config.local.json"), JSON.stringify({ providers: { author: { provider: "claude", model: "primary" } } }));
    await acceptDocs(setup.kitchen);
    expect(setup.calls.filter(call => call.role === "author").map(call => [call.station, call.config?.provider])).toEqual([
      ["intent", "claude"], ["spec", "codex"], ["plan", "claude"], ["test-plan", "claude"],
    ]);
  });

it("blocks approval on opted-in intent review findings", async () => {
    const setup = fixture(0, { intent: { reviewEnabled: true } });
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) =>
        request.role === "review"
          ? {
              summary: "Outcome needs clarification",
              findings: [
                {
                  id: "intent-outcome",
                  rule: "outcome",
                  blocking: true,
                  evidence: "Intent does not define who receives the answer",
                  consequence: "The recipient is ambiguous",
                  resolution: "Name the recipient",
                },
              ],
            }
          : setup.provider(request),
    });
    await kitchen.start("answer", { request: "Return 42." });
    await kitchen.run("answer", "intent");
    await expect(
      kitchen.approve("answer", "intent", { actor: "chef" }),
    ).rejects.toThrow(/blocking findings/);
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
});
