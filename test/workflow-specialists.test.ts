import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hash } from "../src/domain.ts";
import { Kitchen } from "../src/kitchen.ts";
import type { Config, ProviderRequest } from "../src/types.ts";
import { fixture } from "./workflow-fixture.ts";

describe("station specialists", () => {
  it("joins two advisory tasks before authoring, refreshes them after answers, and keeps verification evidence and approval gates", async () => {
    const setup = fixture(0, {
      spec: { specialistsEnabled: true, author: { provider: "claude" } },
      "test-plan": { specialistsEnabled: true },
      verify: { specialistsEnabled: true, reviewEnabled: true },
    });
    const requests: ProviderRequest[] = [];
    let active = 0;
    let maximum = 0;
    const question = "Who can call this function?";
    const answer = "All local callers.";
    const kitchen = new Kitchen({ root: setup.root, github: setup.gateway, provider: async (request) => {
      requests.push(request);
      if (request.kind === "specialist") {
        if (request.station === "spec") expect(request.config.provider).toBe("claude");
        const task = path.basename(request.runDir);
        const first = ["business-rules", "acceptance-coverage", "behavior"].includes(task);
        maximum = Math.max(maximum, ++active);
        if (first) await new Promise<void>(resolve => setImmediate(resolve));
        active--;
        return {
          summary: task,
          evidence: [{ path: "src/answer.ts", line: 1, hash: "" }],
          unresolved: request.station === "spec" && !request.prompt.includes(answer) && first ? [question] : [],
        };
      }
      expect(active).toBe(0);
      if (request.station === "verify" && request.role === "review") {
        expect(request.prompt).toContain('"status":"passed"');
        expect(existsSync(path.join(path.dirname(request.runDir), "raw-answer-unit.json"))).toBe(true);
      }
      const output = await setup.provider(request);
      if (request.station === "spec" && request.role === "author" && "questions" in output) {
        expect(request.prompt.indexOf('"taskId":"business-rules"')).toBeLessThan(request.prompt.indexOf('"taskId":"failure-cases"'));
        expect(request.prompt).toContain(hash(readFileSync(path.join(request.cwd, "src/answer.ts"), "utf8")));
        if (!request.prompt.includes(answer)) {
          expect(request.prompt).toContain(`"unresolved":["${question}"]`);
          return { ...output, document: null, questions: [{ id: "caller", text: question }] };
        }
      }
      return output;
    } });
    const state = await kitchen.start("answer", { request: "Return 42." });
    await expect(kitchen.run("answer", "spec")).rejects.toThrow("Approve intent");
    expect(requests).toHaveLength(0);
    await kitchen.run("answer", "intent");
    await kitchen.approve("answer", "intent", { actor: "chef" });
    const spec = await kitchen.run("answer", "spec", { ask: async (text) => {
      expect(text).toBe(question);
      expect(existsSync(path.join(state.worktree, "docs/features/answer/spec.md"))).toBe(false);
      return answer;
    } });
    expect(spec.stations.spec?.status).toBe("awaiting-approval");
    await expect(kitchen.run("answer", "plan")).rejects.toThrow("Approve spec");
    await kitchen.approve("answer", "spec", { actor: "chef" });
    for (const station of ["plan", "test-plan", "unit-tests", "implementation"] as const) {
      await kitchen.run("answer", station);
      await kitchen.approve("answer", station, { actor: "chef" });
    }
    const verified = await kitchen.run("answer", "verify");
    expect(verified.stations.verify?.status).toBe("awaiting-approval");
    expect(verified.stations.verify?.checks.map(check => check.status)).toEqual(["passed"]);
    await expect(kitchen.publish("answer", { preview: true })).rejects.toThrow("Approve verify");
    expect(maximum).toBe(2);
    const specialists = requests.filter(request => request.kind === "specialist");
    expect(specialists.map(({ station }) => station)).toEqual([
      "spec", "spec", "spec", "spec", "test-plan", "test-plan", "verify", "verify",
    ]);
    expect(specialists.filter(request => request.prompt.includes(answer))).toHaveLength(6);
    expect(new Set(specialists.map(request => request.runDir)).size).toBe(8);
    for (const request of specialists)
      expect(existsSync(path.join(request.runDir, "validated-output.json"))).toBe(true);
    await kitchen.approve("answer", "verify", { actor: "chef" });

    const configFile = path.join(setup.root, "kitchen.config.json");
    const config: Config = JSON.parse(readFileSync(configFile, "utf8"));
    config.stations.verify!.specialistsEnabled = false;
    writeFileSync(configFile, JSON.stringify(config));
    const refreshed = await kitchen.status("answer");
    expect(refreshed.stations.implementation?.status).toBe("approved");
    expect(refreshed.stations.verify?.status).toBe("stale");
  });

  it("rejects an uncited source mutation before passing specialist results to the author", async () => {
    const setup = fixture(0, { spec: { specialistsEnabled: true } });
    let taskDir: string | undefined;
    const kitchen = new Kitchen({ root: setup.root, github: setup.gateway, provider: async (request) => {
      if (request.kind !== "specialist") return setup.provider(request);
      taskDir = request.runDir;
      if (request.prompt.includes("(business-rules)"))
        writeFileSync(path.join(request.cwd, "src/uncited.ts"), "export const changed = true;\n");
      return { summary: "Existing source", evidence: [{ path: "src/answer.ts", line: 1, hash: "" }], unresolved: [] };
    } });
    await kitchen.start("answer", { request: "Return 42." });
    await kitchen.run("answer", "intent");
    await kitchen.approve("answer", "intent", { actor: "chef" });
    await expect(kitchen.run("answer", "spec")).rejects.toThrow("Specialist provider changed repository contents outside the runner.");
    expect((await kitchen.status("answer")).stations.spec?.status).toBe("failed");
    expect(setup.calls.some(call => call.station === "spec")).toBe(false);
    expect(existsSync(path.join(taskDir!, "validated-output.json"))).toBe(false);
  });
});
