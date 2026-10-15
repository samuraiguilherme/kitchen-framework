import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeSetup } from "../src/setup-runner.ts";
import { executeCheck, executeChecks } from "../src/checks.ts";
import { runProcess } from "../src/process.ts";
import type { Profile } from "../src/types.ts";

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
const profile: Profile = {
  kind: "command",
  command: "check",
  args: [],
  parser: "exit-code",
  timeoutMs: 1000,
  setup: {
    command: "pnpm",
    args: ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    timeoutMs: 1000,
  },
};
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-setup-"));
  mkdirSync(path.join(root, "node_modules"));
  mkdirSync(path.join(root, "apps", "one"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}');
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - apps/*\n",
  );
  writeFileSync(path.join(root, "apps/one/package.json"), '{"name":"one"}');
  writeFileSync(
    path.join(root, "node_modules/.modules.yaml"),
    "layoutVersion: 5\n",
  );
  return root;
}
const installs = () =>
  vi
    .mocked(runProcess)
    .mock.calls.filter(([input]) => input.args.includes("install"));
beforeEach(() => {
  vi.mocked(runProcess).mockReset();
  vi.mocked(runProcess).mockImplementation(async (input) => ({
    ...ok,
    stdout: input.args[0] === "--version" ? "9.15.9\n" : "",
  }));
});

describe("dependency setup evidence cache", () => {
  it("fails closed on stale ownership without deleting a competing lock", async () => {
    const root = fixture();
    const lock = path.join(root, ".kitchen/cache/setup/install.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "stale-owner" }),
    );
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    try {
      await expect(executeSetup({ root, cwd: root, profile })).rejects.toThrow(
        "Stale workspace dependency setup lock",
      );
      expect(
        JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8")).token,
      ).toBe("stale-owner");
      expect(installs()).toHaveLength(0);
    } finally {
      probe.mockRestore();
    }
  });
  it("persists successful setup, invalidates content changes without mtime shortcuts, and observes pnpm version", async () => {
    const root = fixture();
    const input = { root, cwd: root, profile };
    expect(await executeSetup(input)).toMatchObject({
      code: 0,
      cacheHit: false,
    });
    expect(await executeSetup(input)).toMatchObject({
      code: 0,
      cacheHit: true,
    });
    expect(installs()).toHaveLength(1);
    const lock = path.join(root, "pnpm-lock.yaml");
    const previous = statSync(lock);
    writeFileSync(lock, readFileSync(lock, "utf8").replace("9", "8"));
    utimesSync(lock, previous.atime, previous.mtime);
    expect(await executeSetup(input)).toMatchObject({ cacheHit: false });
    expect(await executeSetup(input)).toMatchObject({ cacheHit: true });
    for (const file of [
      "pnpm-lock.yaml",
      "package.json",
      "apps/one/package.json",
      "pnpm-workspace.yaml",
      "node_modules/.modules.yaml",
    ]) {
      writeFileSync(
        path.join(root, file),
        readFileSync(path.join(root, file), "utf8") + "\n",
      );
      expect(await executeSetup(input)).toMatchObject({
        code: 0,
        cacheHit: false,
      });
      expect(await executeSetup(input)).toMatchObject({
        code: 0,
        cacheHit: true,
      });
    }
    expect(installs()).toHaveLength(7);
    expect(
      await executeSetup({
        ...input,
        profile: { ...profile, env: { SETUP_MODE: "changed" } },
      }),
    ).toMatchObject({ cacheHit: false });
    expect(
      await executeSetup({
        ...input,
        profile: {
          ...profile,
          setup: {
            ...profile.setup!,
            args: [...profile.setup!.args, "--filter", "one"],
          },
        },
      }),
    ).toMatchObject({ cacheHit: false });
    vi.mocked(runProcess).mockImplementation(async (input) => ({
      ...ok,
      stdout: input.args[0] === "--version" ? "10.0.0\n" : "",
    }));
    expect(await executeSetup(input)).toMatchObject({
      cacheHit: false,
      pnpmVersion: "10.0.0",
    });
    expect(installs()).toHaveLength(10);
    expect(
      readdirSync(path.join(root, ".kitchen/cache/setup")).some((file) =>
        file.endsWith(".json"),
      ),
    ).toBe(true);
  });

  it("invalidates newly added workspace manifests and rejects inputs changed by setup", async () => {
    const root = fixture();
    const input = { root, cwd: root, profile };
    await executeSetup(input);
    mkdirSync(path.join(root, "apps/two"));
    writeFileSync(path.join(root, "apps/two/package.json"), '{"name":"two"}');
    expect(await executeSetup(input)).toMatchObject({ cacheHit: false });
    expect(installs()).toHaveLength(2);
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "changed\n");
    vi.mocked(runProcess).mockImplementation(async (request) => {
      if (request.args[0] === "--version") return { ...ok, stdout: "9.15.9" };
      writeFileSync(path.join(root, "package.json"), '{"name":"mutated"}');
      return ok;
    });
    expect(await executeSetup(input)).toMatchObject({
      code: -1,
      cacheHit: false,
      failureReason: "Dependency inputs changed during setup.",
    });
  });

  it("serializes installs across distinct profiles and never caches failures", async () => {
    const root = fixture();
    let active = 0,
      maximum = 0;
    vi.mocked(runProcess).mockImplementation(async (input) => {
      if (input.args[0] === "--version") return { ...ok, stdout: "9.15.9" };
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return { ...ok, code: 1, stderr: "dependency setup failure" };
    });
    const different = {
      ...profile,
      setup: {
        ...profile.setup!,
        args: [...profile.setup!.args, "--filter", "one"],
      },
    };
    const results = await Promise.all([
      executeSetup({ root, cwd: root, profile }),
      executeSetup({ root, cwd: root, profile: different }),
    ]);
    expect(
      results.every((result) => result.code === 1 && !result.cacheHit),
    ).toBe(true);
    expect(maximum).toBe(1);
    await executeSetup({ root, cwd: root, profile });
    expect(installs()).toHaveLength(3);
  });

  it("does not reuse success without installation markers, and cancels while waiting for another setup", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-no-install-"));
    await executeSetup({ root, cwd: root, profile });
    expect(await executeSetup({ root, cwd: root, profile })).toMatchObject({
      cacheHit: false,
    });
    expect(installs()).toHaveLength(2);
    const lock = path.join(root, ".kitchen/cache/setup/install.lock");
    mkdirSync(lock);
    writeFileSync(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "another-owner" }),
    );
    const controller = new AbortController();
    const waiting = executeSetup({
      root,
      cwd: root,
      profile,
      signal: controller.signal,
    });
    controller.abort();
    expect(await waiting).toMatchObject({
      cancelled: true,
      code: -1,
      cacheHit: false,
    });
    expect(installs()).toHaveLength(2);
  });

  it("shares setup before checks, preserves cache evidence, and cannot classify a setup failure as RED", async () => {
    const root = fixture();
    const base = {
      root,
      runDir: path.join(root, ".kitchen/evidence"),
      fingerprint: "source",
      green: false,
    };
    const definition = {
      id: "one",
      profile: "unit",
      files: [],
      acIds: [],
      required: true,
      expectation: "red" as const,
    };
    const results = await executeChecks({
      ...base,
      definitions: [definition, { ...definition, id: "two" }],
      profiles: { unit: profile },
    });
    expect(results.map((result) => result.id)).toEqual(["one", "two"]);
    expect(installs()).toHaveLength(1);
    const standalone = await executeCheck({
      ...base,
      definition: { ...definition, id: "three" },
      profile,
    });
    expect(standalone.durationMs).toBeGreaterThanOrEqual(0);
    expect(
      JSON.parse(
        readFileSync(path.join(base.runDir, "setup-three.json"), "utf8"),
      ),
    ).toMatchObject({ cacheHit: true });
    expect(standalone.evidenceHashes).toHaveProperty(
      path.join(base.runDir, "setup-three.json"),
    );
    vi.mocked(runProcess).mockImplementation(async (input) => ({
      ...ok,
      code: input.args.includes("install") ? 1 : 0,
      stdout: input.args[0] === "--version" ? "9.15.9" : "",
    }));
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "changed");
    const failed = await executeChecks({
      ...base,
      definitions: [definition, { ...definition, id: "two" }],
      profiles: { unit: profile },
    });
    expect(
      failed.every(
        (result) =>
          result.status === "unverified" &&
          result.reason?.includes("infrastructure"),
      ),
    ).toBe(true);
    expect(installs()).toHaveLength(2);
  });
});
