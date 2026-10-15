import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeChecks } from "../src/checks.ts";
import { runProcess } from "../src/process.ts";
import type { CheckDefinition, Profile } from "../src/types.ts";

vi.mock("../src/process.ts", () => ({
  runProcess: vi.fn(),
  stopProcess: vi.fn(),
}));
const ok = {
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  cancelled: false,
};
const definition = (id: string, profile = id): CheckDefinition => ({
  id,
  profile,
  files: [],
  acIds: [],
  required: true,
  expectation: "green",
});
const profile = (id: string, extra: Partial<Profile> = {}): Profile => ({
  kind: "command",
  command: id,
  args: [],
  parser: "exit-code",
  timeoutMs: 1000,
  parallelSafe: true,
  resourceGroup: id,
  ...extra,
});
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-check-runner-"));
  return {
    root,
    runDir: path.join(root, ".kitchen/evidence"),
    fingerprint: "source",
    green: true,
  };
};
beforeEach(() => {
  vi.mocked(runProcess).mockReset();
});

describe("bounded check scheduling", () => {
  it("treats cwd aliases of one directory as the same default resource", async () => {
    const input = fixture();
    const shared = path.join(input.root, "shared");
    mkdirSync(shared);
    mkdirSync(path.join(shared, "project"));
    symlinkSync(shared, path.join(input.root, "alias-one"), "junction");
    symlinkSync(shared, path.join(input.root, "alias-two"), "junction");
    let active = 0,
      maximum = 0;
    vi.mocked(runProcess).mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return ok;
    });
    await executeChecks({
      ...input,
      definitions: [definition("one"), definition("two")],
      profiles: {
        one: profile("one", {
          cwd: "alias-one/project",
          resourceGroup: undefined,
        }),
        two: profile("two", {
          cwd: "alias-two/project",
          resourceGroup: undefined,
        }),
      },
    });
    expect(maximum).toBe(1);
  });
  it("serializes a shared fixture across different cwd and explicit resource groups", async () => {
    const input = fixture();
    mkdirSync(path.join(input.root, "one"));
    mkdirSync(path.join(input.root, "two"));
    writeFileSync(path.join(input.root, "fixture.json"), "{}");
    let active = 0,
      maximum = 0;
    vi.mocked(runProcess).mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return ok;
    });
    await executeChecks({
      ...input,
      definitions: [definition("one"), definition("two")],
      profiles: {
        one: profile("one", {
          kind: "integration",
          cwd: "one",
          fixture: "fixture.json",
        }),
        two: profile("two", {
          kind: "integration",
          cwd: "two",
          fixture: "fixture.json",
        }),
      },
    });
    expect(maximum).toBe(1);
  });
  it("uses two slots, preserves result order, and waits for exclusive barriers", async () => {
    const input = fixture();
    let active = 0,
      maximum = 0;
    const events: string[] = [];
    vi.mocked(runProcess).mockImplementation(async ({ command }) => {
      events.push(`start:${command}:${active}`);
      active++;
      maximum = Math.max(active, maximum);
      await new Promise((resolve) =>
        setTimeout(resolve, command === "slow" ? 40 : 10),
      );
      active--;
      events.push(`end:${command}`);
      return ok;
    });
    const ids = ["slow", "fast", "next", "exclusive", "last"];
    const profiles = Object.fromEntries(
      ids.map((id) => [
        id,
        profile(id, id === "exclusive" ? { parallelSafe: false } : {}),
      ]),
    );
    const results = await executeChecks({
      ...input,
      definitions: ids.map((id) => definition(id)),
      profiles,
    });
    expect(results.map((result) => result.id)).toEqual(ids);
    expect(maximum).toBe(2);
    expect(events.indexOf("start:next:1")).toBeLessThan(
      events.indexOf("end:slow"),
    );
    expect(events).toContain("start:exclusive:0");
    expect(events.indexOf("end:slow")).toBeLessThan(
      events.indexOf("start:exclusive:0"),
    );
    expect(events.indexOf("end:exclusive")).toBeLessThan(
      events.indexOf("start:last:0"),
    );
  });

  it("serializes equal resource groups and default cwd groups, even when opted in", async () => {
    for (const extra of [
      { resourceGroup: "shared" },
      { resourceGroup: undefined },
    ]) {
      let active = 0,
        maximum = 0;
      vi.mocked(runProcess).mockImplementation(async () => {
        active++;
        maximum = Math.max(active, maximum);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return ok;
      });
      await executeChecks({
        ...fixture(),
        definitions: [definition("one"), definition("two")],
        profiles: { one: profile("one", extra), two: profile("two", extra) },
      });
      expect(maximum).toBe(1);
    }
  });

  it("keeps an opted-in manual check exclusive and leaves cancelled checks unexecuted", async () => {
    const input = fixture();
    const controller = new AbortController();
    vi.mocked(runProcess).mockImplementation(async () => {
      controller.abort();
      return { ...ok, code: -1, cancelled: true };
    });
    const results = await executeChecks({
      ...input,
      signal: controller.signal,
      definitions: [
        definition("one"),
        definition("manual"),
        definition("last"),
      ],
      profiles: {
        one: profile("one"),
        manual: { kind: "manual", parallelSafe: true },
        last: profile("last"),
      },
    });
    expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.reason)).toEqual([
      "Check cancelled.",
      "Check cancelled.",
      "Check cancelled.",
    ]);
  });
});
