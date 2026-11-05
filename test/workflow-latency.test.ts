import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { Kitchen } from "../src/kitchen.ts";
import type { ProviderRequest } from "../src/types.ts";
import { git, fixture } from "./workflow-fixture.ts";

describe("station latency safeguards", () => {
  it.each(["unchanged", "source", "instructions", "model", "history", "recovered"])("isolates after-input author sessions when %s", async change => {
    const setup = fixture();
    let digest = "a".repeat(64);
    const server = createServer((_request, response) => response.end(JSON.stringify({ models: [{ name: "local", digest }] })));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    try {
      writeFileSync(path.join(setup.root, "kitchen.config.local.json"), JSON.stringify({ providers: { author: {
        provider: "deepseek", model: "local", sessionReuse: "after-input",
        dsh: { version: "0.2.2-alpha.3", baseURL: `http://127.0.0.1:${address.port}/v1`, contextWindow: 16384, maxTokens: 8192 },
      } } }));
      const calls: ProviderRequest[] = [];
      const kitchen = new Kitchen({ root: setup.root, github: setup.gateway, provider: async request => {
        calls.push(request);
        if (calls.length === 1) {
          const home = change === "recovered" ? path.join(path.dirname(request.session!.home), "fresh-recovery") : undefined;
          if (home) mkdirSync(home, { recursive: true });
          request.onSession?.("session-initial", home);
          return { summary: "Question", questions: [{ id: "who", text: "Who needs this?" }], document: null, files: [], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [] };
        }
        return setup.provider(request);
      } });
      await kitchen.start("answer", { request: "Return 42" });
      const waiting = await kitchen.run("answer", "intent");
      expect(waiting.stations.intent?.authorSession?.id).toBe("session-initial");
      if (change === "source") writeFileSync(path.join(waiting.worktree, "src/answer.ts"), "export const answer = () => 40;");
      if (change === "instructions") writeFileSync(path.join(waiting.worktree, "AGENTS.md"), "New convention");
      if (change === "model") digest = "b".repeat(64);
      if (change === "history") {
        const file = path.join(setup.root, ".kitchen/features/answer/state.json");
        const state = JSON.parse(readFileSync(file, "utf8")); state.conversation[0].text = "Edited original request"; writeFileSync(file, JSON.stringify(state));
      }
      await kitchen.run("answer", "intent", { feedback: "Local callers need exactly 42" });
      expect(calls[1]?.session?.id).toBe(["unchanged", "recovered"].includes(change) ? "session-initial" : undefined);
      if (change === "recovered") expect(path.basename(calls[1]!.session!.home)).toBe("fresh-recovery");
      if (change === "unchanged") {
        expect(calls[1]?.prompt).toContain("Human/model continuation");
        expect(calls[1]?.prompt).not.toContain("Existing template");
        expect(calls[1]?.freshPrompt).toContain("Existing template");
      }
      expect((await kitchen.status("answer")).stations.intent?.authorSession).toBeUndefined();
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it("uses opt-in compact prompts and makes token-policy changes stale the candidate", async () => {
    const setup = fixture();
    const server = createServer((_request, response) => response.end(JSON.stringify({ models: [{ name: "local", digest: "a".repeat(64) }] })));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    try {
    const configFile = path.join(setup.root, "kitchen.config.local.json");
    const author = { provider: "deepseek", model: "local", dsh: { version: "0.2.2-alpha.3", baseURL: `http://127.0.0.1:${address.port}/v1`, contextWindow: 8192, maxTokens: 2048, tokenPolicy: { version: 1, maxSteps: 4 } } };
    writeFileSync(configFile, JSON.stringify({ providers: { author } }));
    await setup.kitchen.start("answer", { request: "Return 42." });
    await setup.kitchen.run("answer", "intent");
    expect(setup.calls[0]!.prompt).not.toContain("- reviewer:");
    await setup.kitchen.approve("answer", "intent", { actor: "chef" });
    author.dsh.tokenPolicy.maxSteps = 5;
    writeFileSync(configFile, JSON.stringify({ providers: { author } }));
    expect((await setup.kitchen.status("answer")).stations.intent?.status).toBe("stale");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("records preparation before provider progress and excludes interactive waiting from machine time", async () => {
    const setup = fixture();
    let authors = 0;
    const progress: string[] = [];
    const kitchen = new Kitchen({
      root: setup.root,
      provider: async (request) => {
        expect(progress[0]).toBe("Preparing approval refresh…");
        if (++authors === 1)
          return {
            summary: "",
            questions: [{ id: "scope", text: "Which answer?" }],
            document: null,
            files: [],
            allowedPaths: [],
            checks: [],
            unitTestFiles: [],
            scaffoldFiles: [],
          };
        return setup.provider(request);
      },
    });
    await kitchen.start("answer", { request: "Return the requested answer." });
    const state = await kitchen.run("answer", "intent", {
      onProgress: (message) => progress.push(message),
      ask: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return "42";
      },
    });
    const metrics = state.stations.intent!.metrics!;
    expect(metrics.humanWaitMs).toBeGreaterThanOrEqual(20);
    expect(metrics.durationMs).toBeGreaterThan(0);
    expect(metrics.firstActionableMs).toBeGreaterThan(0);
    expect(
      metrics.phases.some(
        ({ phase }) => phase === "source snapshot before provider",
      ),
    ).toBe(true);
    expect(metrics.promptBytes).toHaveLength(2);
    expect(metrics.sourceSnapshots?.[0]?.fileCount).toBeGreaterThan(0);
    expect(
      JSON.parse(
        readFileSync(
          path.join(
            setup.root,
            ".kitchen/features/answer/runs",
            state.stations.intent!.runId,
            "metrics.json",
          ),
          "utf8",
        ),
      ),
    ).toEqual(metrics);
  });

  it("binds intent approval to the target instructions that supplied its context", async () => {
    const setup = fixture();
    mkdirSync(path.join(setup.root, "apps/demo-web"), { recursive: true });
    writeFileSync(
      path.join(setup.root, "apps/demo-web/AGENTS.md"),
      "Use the existing board.\n",
    );
    git(setup.root, "add", "apps");
    git(setup.root, "commit", "-m", "target instructions");
    git(
      setup.root,
      "update-ref",
      "refs/remotes/origin/develop",
      git(setup.root, "rev-parse", "HEAD"),
    );
    await setup.kitchen.start("answer", {
      request: "Add a button in apps/demo-web.",
    });
    await setup.kitchen.run("answer", "intent");
    const approved = await setup.kitchen.approve("answer", "intent", {
      actor: "chef",
    });
    writeFileSync(
      path.join(approved.worktree, "apps/demo-web/AGENTS.md"),
      "Changed board conventions.\n",
    );
    expect((await setup.kitchen.status("answer")).stations.intent?.status).toBe(
      "stale",
    );
  });

  it("uses discovery only as source-verified plan context and preserves serial station approval", async () => {
    const setup = fixture();
    const file = path.join(setup.root, "kitchen.config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.discovery = { enabled: true };
    writeFileSync(file, JSON.stringify(config));
    let workers = 0;
    const kitchen = new Kitchen({
      root: setup.root,
      provider: async (request) => {
        if (request.kind === "discovery") {
          workers++;
          return {
            summary: "Existing answer module",
            evidence: [{ path: "src/answer.ts", line: 1, hash: "" }],
            unresolved: [],
          };
        }
        return setup.provider(request);
      },
    });
    await kitchen.start("answer", { request: "Return 42." });
    await expect(kitchen.run("answer", "plan")).rejects.toThrow(
      "Approve intent",
    );
    for (const station of ["intent", "spec"] as const) {
      await kitchen.run("answer", station);
      await kitchen.approve("answer", station, { actor: "chef" });
    }
    const plan = await kitchen.run("answer", "plan");
    expect(workers).toBe(2);
    expect(plan.stations.plan?.status).toBe("awaiting-approval");
    await expect(kitchen.run("answer", "test-plan")).rejects.toThrow(
      "Approve plan",
    );
    await kitchen.approve("answer", "plan", { actor: "chef" });
    await kitchen.run("answer", "test-plan");
    expect(
      setup.calls.find((call) => call.station === "test-plan")?.prompt,
    ).toContain("DISCOVERY (read-only findings");
    expect(workers).toBe(2);
    await kitchen.run("answer", "intent");
    expect(
      setup.calls.filter((call) => call.station === "intent").at(-1)?.prompt,
    ).not.toContain("DISCOVERY (read-only findings");
  });
});
