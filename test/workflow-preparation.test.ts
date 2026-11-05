import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { preparedFixture } from "./workflow-fixture.ts";

describe("operator runner preparation", () => {
  it("resumes the handoff with raw evidence and runtime snapshots while feature code stays pinned", async () => {
    const setup = await preparedFixture();
    const pending = await setup.kitchen.run("answer", "unit-tests");
    expect(pending.stations["unit-tests"]?.status).toBe("awaiting-input");
    const prepared = await setup.kitchen.prepare("answer", setup.request);
    expect(
      prepared.preparation?.status,
      readFileSync(prepared.preparation!.artifact, "utf8"),
    ).toBe("passed");
    expect(prepared.stations["unit-tests"]?.status).toBe("stale");
    const artifact = JSON.parse(
      readFileSync(prepared.preparation!.artifact, "utf8"),
    );
    expect(artifact.documents.plan.commit).toBe(prepared.stations.plan?.commit);
    expect(artifact.environment).toMatchObject({
      platform: process.platform,
      node: process.version,
    });
    expect(artifact.filesAfter).toEqual(artifact.files);
    const directory = path.dirname(prepared.preparation!.artifact);
    const execution = JSON.parse(
      readFileSync(path.join(directory, "raw-k-architecture.json"), "utf8"),
    );
    expect(execution).toMatchObject({
      code: 0,
      stdout: "architecture GREEN\n",
      stderr: "",
      profile: "architecture",
      cwd: prepared.worktree,
    });
    expect(execution.startedAt).toBeTruthy();
    expect(execution.finishedAt).toBeTruthy();
    expect(
      JSON.parse(readFileSync(path.join(directory, "setup-unit.json"), "utf8")),
    ).toMatchObject({ code: 0, profile: "unit", files: artifact.files });
    // Candidate production changes must not leak into the RED baseline.
    writeFileSync(
      path.join(prepared.worktree, "src/answer.ts"),
      "export const answer = 42;\n",
    );
    const resumed = await setup.kitchen.run("answer", "unit-tests");
    expect(resumed.stations["unit-tests"]?.status).toBe("awaiting-approval");
    expect(resumed.stations["unit-tests"]?.checks[0]?.status).toBe(
      "expected-red",
    );
    const prompt = setup.calls.at(-1)!.prompt;
    expect(prompt).toContain(prepared.preparation!.artifact);
    expect(prompt).toContain(prepared.preparation!.runId);
    const baseline = JSON.parse(
      readFileSync(
        path.join(
          setup.root,
          ".kitchen/features/answer/runs",
          resumed.stations["unit-tests"]!.runId,
          "baseline.json",
        ),
        "utf8",
      ),
    );
    expect(
      readFileSync(path.join(baseline.path, "src/answer.ts"), "utf8"),
    ).toContain("= 0");
    for (const file of setup.files)
      expect(readFileSync(path.join(baseline.path, file), "utf8")).toBe(
        readFileSync(path.join(prepared.worktree, file), "utf8"),
      );
  });

  it("retains setup failure evidence and blocks the author before calling it", async () => {
    const setup = await preparedFixture(1);
    const prepared = await setup.kitchen.prepare("answer", setup.request);
    expect(prepared.preparation?.status).toBe("failed");
    const directory = path.dirname(prepared.preparation!.artifact);
    expect(
      JSON.parse(readFileSync(path.join(directory, "setup-unit.json"), "utf8")),
    ).toMatchObject({ code: 1 });
    const calls = setup.calls.length;
    await expect(setup.kitchen.run("answer", "unit-tests")).rejects.toThrow(
      /Runner preparation failed/,
    );
    expect(setup.calls).toHaveLength(calls);
  });

  it.each(["source", "snapshot", "evidence", "profile"])(
    "rejects changed preparation %s before authoring",
    async (kind) => {
      const setup = await preparedFixture();
      const prepared = await setup.kitchen.prepare("answer", setup.request);
      expect(
        prepared.preparation?.status,
        readFileSync(prepared.preparation!.artifact, "utf8"),
      ).toBe("passed");
      const directory = path.dirname(prepared.preparation!.artifact);
      if (kind === "source")
        writeFileSync(path.join(prepared.worktree, setup.files[0]!), "changed");
      if (kind === "snapshot")
        writeFileSync(path.join(directory, setup.files[0]!), "changed");
      if (kind === "evidence")
        writeFileSync(
          path.join(directory, "raw-k-architecture.json"),
          "changed",
        );
      if (kind === "profile") {
        const file = path.join(setup.root, "kitchen.config.json");
        const config = JSON.parse(readFileSync(file, "utf8"));
        config.profiles.architecture.args = ["-e", "process.exit(0)"];
        writeFileSync(file, JSON.stringify(config));
      }
      const calls = setup.calls.length;
      await expect(setup.kitchen.run("answer", "unit-tests")).rejects.toThrow(
        /changed|stale/i,
      );
      expect(setup.calls).toHaveLength(calls);
    },
  );

  it("rejects feature implementations as runtime preparation", async () => {
    const setup = await preparedFixture();
    await expect(
      setup.kitchen.prepare("answer", {
        ...setup.request,
        files: ["src/answer.ts"],
      }),
    ).rejects.toThrow(/not feature code/);
    expect((await setup.kitchen.status("answer")).preparation).toBeUndefined();
  });
});
