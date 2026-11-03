import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discover } from "../src/discovery.ts";
import { hash } from "../src/domain.ts";
import { loadConfig } from "../src/config.ts";
import type {
  DiscoveryResult,
  FeatureState,
  Provider,
  ProviderRequest,
} from "../src/types.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-discovery-"));
  roots.push(root);
  const write = (file: string, content: string) => {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  write("AGENTS.md", "Follow the repository conventions.");
  write("apps/demo-web/package.json", '{"name":"@example/demo-web"}');
  write("apps/demo-web/AGENTS.md", "Preserve board columns.");
  write(
    "apps/demo-web/src/board.ts",
    "export const columns = [];\n// board implementation\n",
  );
  write(
    "apps/demo-web/src/board.test.ts",
    "// board test\n// AC-1 preservation\n",
  );
  const config = loadConfig(root);
  const state: FeatureState = {
    version: 1,
    feature: "sort-items",
    request: "Add a column sort button in demo-web.",
    worktree: root,
    branch: "codex/kitchen/sort-items",
    baseCommit: "baseline",
    conversation: [],
    stations: {},
  };
  const output = (request: ProviderRequest): DiscoveryResult => ({
    summary: request.prompt.includes("(implementation)")
      ? "Existing board implementation"
      : "Existing board tests",
    evidence: [
      {
        path: request.prompt.includes("(implementation)")
          ? "apps/demo-web/src/board.ts"
          : "apps/demo-web/src/board.test.ts",
        line: 2,
        hash: "",
      },
    ],
    unresolved: [],
  });
  const options = (
    provider: Provider,
    extra: Partial<Parameters<typeof discover>[0]> = {},
  ) => ({
    root,
    state,
    config,
    codeFingerprint: "code-v1",
    provider,
    runDir: path.join(root, ".kitchen", "runs", "discovery"),
    ...extra,
  });
  return { root, state, config, write, output, options };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("read-only repository discovery", () => {
  it("invalidates runtime profile changes and honors cancellation even on a cache hit", async () => {
    const setup = fixture();
    let calls = 0;
    const provider: Provider = async (request) => {
      calls++;
      return setup.output(request);
    };
    await discover(setup.options(provider));
    setup.config.profiles.architecture = {
      kind: "command",
      command: "node",
      args: ["check.mjs"],
      parser: "exit-code",
      timeoutMs: 1000,
    };
    await discover(setup.options(provider));
    expect(calls).toBe(4);
    const controller = new AbortController();
    controller.abort();
    await expect(
      discover(setup.options(provider, { signal: controller.signal })),
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(4);
  });
  it("starts exactly two independent workers concurrently and verifies their cited source", async () => {
    const setup = fixture();
    const calls: ProviderRequest[] = [];
    let active = 0;
    let maximum = 0;
    const provider: Provider = async (request) => {
      calls.push(request);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return setup.output(request);
    };
    const results = await discover(setup.options(provider));
    expect(maximum).toBe(2);
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (request) =>
          request.kind === "discovery" &&
          request.station === "plan" &&
          request.role === "author",
      ),
    ).toBe(true);
    expect(new Set(calls.map((request) => request.runDir)).size).toBe(2);
    expect(
      calls.every((request) => request.prompt.includes("No file proposals.")),
    ).toBe(true);
    for (const result of results)
      for (const citation of result.evidence)
        expect(citation.hash).toBe(
          hash(readFileSync(path.join(setup.root, citation.path), "utf8")),
        );
    expect(setup.config.discovery?.enabled ?? false).toBe(false);
  });

  it("reuses only source-verified cached findings and invalidates on source keys, citations or instructions", async () => {
    const setup = fixture();
    let calls = 0;
    const provider: Provider = async (request) => {
      calls++;
      return setup.output(request);
    };
    const first = await discover(setup.options(provider));
    expect(await discover(setup.options(provider))).toEqual(first);
    expect(calls).toBe(2);
    await discover(setup.options(provider, { codeFingerprint: "code-v2" }));
    expect(calls).toBe(4);
    setup.write(
      "apps/demo-web/src/board.ts",
      "export const columns = ['changed'];\n// modified implementation\n",
    );
    await discover(setup.options(provider, { codeFingerprint: "code-v2" }));
    expect(calls).toBe(6);
    setup.write("apps/demo-web/AGENTS.md", "Changed target instructions.");
    await discover(setup.options(provider, { codeFingerprint: "code-v2" }));
    expect(calls).toBe(8);
  });

  it.each([
    { path: "../outside.ts", line: 1 },
    { path: ".env", line: 1 },
    { path: "missing.ts", line: 1 },
    { path: "apps/demo-web/src/board.ts", line: 0 },
    { path: "apps/demo-web/src/board.ts", line: 99 },
  ])(
    "rejects invalid source evidence $path:$line without caching it",
    async (citation) => {
      const setup = fixture();
      const provider: Provider = async () => ({
        summary: "Invalid citation",
        evidence: [{ ...citation, hash: "" }],
        unresolved: [],
      });
      await expect(discover(setup.options(provider))).rejects.toThrow();
      expect(
        existsSync(
          path.join(setup.root, ".kitchen/features/sort-items/discovery"),
        ),
      ).toBe(false);
    },
  );

  it("rejects structured file proposals instead of accepting discovery as a writing agent", async () => {
    const setup = fixture();
    const source = readFileSync(
      path.join(setup.root, "apps/demo-web/src/board.ts"),
      "utf8",
    );
    const provider: Provider = async (request) => ({
      ...setup.output(request),
      files: [
        { path: "apps/demo-web/src/board.ts", content: "replace source" },
      ],
    });
    await expect(discover(setup.options(provider))).rejects.toThrow(
      /Invalid discovery output/,
    );
    expect(
      readFileSync(path.join(setup.root, "apps/demo-web/src/board.ts"), "utf8"),
    ).toBe(source);
  });

  it("cancels both in-flight workers and never saves a cancelled result", async () => {
    const setup = fixture();
    const controller = new AbortController();
    const calls: ProviderRequest[] = [];
    const provider: Provider = async (request) => {
      calls.push(request);
      const pending = new Promise<never>((_resolve, reject) => {
        request.signal!.addEventListener(
          "abort",
          () => reject(new Error("Discovery cancelled.")),
          { once: true },
        );
      });
      if (calls.length === 2) queueMicrotask(() => controller.abort());
      return pending;
    };
    await expect(
      discover(setup.options(provider, { signal: controller.signal })),
    ).rejects.toThrow(/cancelled/);
    expect(calls).toHaveLength(2);
    expect(calls.every((request) => request.signal!.aborted)).toBe(true);
    expect(
      existsSync(
        path.join(setup.root, ".kitchen/features/sort-items/discovery"),
      ),
    ).toBe(false);
  });

  it("aborts a sibling worker promptly when the other worker fails", async () => {
    const setup = fixture();
    let siblingAborted = false;
    const provider: Provider = async (request) => {
      if (request.prompt.includes("(implementation)"))
        throw new Error("Implementation discovery failed.");
      return new Promise<never>((_resolve, reject) => {
        request.signal!.addEventListener(
          "abort",
          () => {
            siblingAborted = true;
            reject(new Error("Sibling cancelled."));
          },
          { once: true },
        );
      });
    };
    await expect(discover(setup.options(provider))).rejects.toThrow(
      /Implementation discovery failed/,
    );
    expect(siblingAborted).toBe(true);
  });
});
