import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Kitchen } from "../src/kitchen.ts";
import { stationOrder } from "../src/domain.ts";
import { git, fixture, acceptDocs } from "./workflow-fixture.ts";

describe("station workflow publication", () => {
it.each([[undefined, "develop", "codex"], [false, "main", "claude"], [true, "release/next", "claude"]] as const)(
    "requires GREEN and human approval with reviewEnabled=%s on %s using %s author",
    async (reviewEnabled, baseBranch, author) => {
      const setup = fixture(
        0,
        Object.fromEntries(
          stationOrder.map((station) => [
            station,
            {
              reviewEnabled,
              review: { provider: author === "claude" ? "codex" : "claude", model: "station-review" },
            },
          ]),
        ),
        baseBranch,
      );
      writeFileSync(path.join(setup.root, "kitchen.config.local.json"), JSON.stringify({ providers: { author: { provider: author, model: "primary-author" } } }));
      await acceptDocs(setup.kitchen);
      for (const station of [
        "unit-tests",
        "implementation",
        "verify",
      ] as const) {
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
      for (const station of stationOrder) {
        const calls = setup.calls.filter((call) => call.station === station);
        expect(calls.map((call) => call.role)).toEqual([
          ...(station === "publish" ? [] : ["author"]),
          ...(reviewEnabled ? ["review"] : []),
        ]);
        if (station !== "publish")
          expect(calls[0]?.config).toEqual({ provider: author, model: "primary-author" });
        if (reviewEnabled)
          expect(calls.at(-1)?.config).toEqual({ provider: author === "claude" ? "codex" : "claude", model: "station-review" });
        if (station !== "publish")
          expect(calls[0]?.prompt).toContain(
            reviewEnabled
              ? "followed by independent review and human approval"
              : "followed by human approval",
          );
      }
      if (reviewEnabled)
        expect(setup.calls.at(-1)?.prompt).toContain(
          "Exact publication preview:",
        );
      await expect(setup.kitchen.publish("answer")).rejects.toThrow(
        /approve publish/,
      );
      await setup.kitchen.approve("answer", "publish", { actor: "chef" });
      if (baseBranch === "main") {
        const remoteCommit = git(setup.remote, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit-tree", `${setup.base}^{tree}`, "-p", setup.base, "-m", "remote base changed");
        git(setup.remote, "update-ref", "refs/heads/main", remoteCommit);
        await expect(setup.kitchen.publish("answer")).rejects.toThrow(/Remote main changed/);
        expect(setup.counts()).toEqual({ created: 0, pushed: 0 });
        git(setup.remote, "update-ref", "refs/heads/main", setup.base);
      }
      const published = await setup.kitchen.publish("answer");
      expect(published.url).toBe(
        "https://github.com/example/project/pull/123",
      );
      await setup.kitchen.publish("answer");
      expect(setup.counts().created).toBe(1);
      expect(setup.publications[0]?.base).toBe(baseBranch);
    },
  );

it("recovers failed publish reviews and preserves blocking findings without remote writes", async () => {
    const setup = fixture(0, { publish: { reviewEnabled: true } });
    await acceptDocs(setup.kitchen);
    for (const station of ["unit-tests", "implementation", "verify"] as const) {
      await setup.kitchen.run("answer", station);
      await setup.kitchen.approve("answer", station, { actor: "chef" });
    }
    let fail = true;
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async (request) => {
        expect(request.station).toBe("publish");
        expect(request.role).toBe("review");
        if (fail) throw new Error("review unavailable");
        return {
          summary: "Describe the behavior in the PR title",
          findings: [
            {
              id: "publish-title",
              rule: "title",
              blocking: true,
              evidence: "Title is feat: answer",
              consequence: "Behavior change is unclear",
              resolution: "Describe the answer change",
            },
          ],
        };
      },
    });
    await expect(kitchen.publish("answer", { preview: true })).rejects.toThrow(
      /review unavailable/,
    );
    expect((await kitchen.status("answer")).stations.publish?.status).toBe(
      "failed",
    );
    await expect(
      kitchen.approve("answer", "publish", { actor: "chef" }),
    ).rejects.toThrow(/failed/);
    fail = false;
    await kitchen.publish("answer", { preview: true });
    expect((await kitchen.status("answer")).stations.publish?.status).toBe(
      "awaiting-approval",
    );
    await expect(
      kitchen.approve("answer", "publish", { actor: "chef" }),
    ).rejects.toThrow(/blocking findings/);
    expect(setup.counts()).toEqual({ created: 0, pushed: 0 });
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

it("recovers a remotely created PR after a failed create response without duplicating it", async () => {
    const setup = fixture();
    let created = 0;
    const gateway = {
      ...setup.gateway,
      find: async () =>
        created ? "https://github.com/example/project/pull/456" : null,
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

it("blocks push URL drift, identity mismatch and base drift before any remote writes", async () => {
    const setup = fixture();
    await acceptDocs(setup.kitchen);
    for (const station of ["unit-tests", "implementation", "verify"] as const) {
      await setup.kitchen.run("answer", station);
      await setup.kitchen.approve("answer", station, { actor: "chef" });
    }
    git(
      setup.root,
      "remote",
      "set-url",
      "--push",
      "origin",
      "https://example.invalid/example/project.git",
    );
    await setup.kitchen.publish("answer", { preview: true });
    await setup.kitchen.approve("answer", "publish", { actor: "chef" });
    await expect(setup.kitchen.publish("answer")).rejects.toThrow(/origin/i);
    expect(setup.counts()).toEqual({ created: 0, pushed: 0 });
    git(setup.root, "remote", "set-url", "--push", "origin", setup.remote);
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
