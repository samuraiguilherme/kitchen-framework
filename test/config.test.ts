import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { stationOrder } from "../src/domain.ts";

function fixture(shared: unknown, local?: unknown) {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-local-config-"));
  writeFileSync(path.join(root, "kitchen.config.json"), JSON.stringify(shared));
  if (local !== undefined)
    writeFileSync(
      path.join(root, "kitchen.config.local.json"),
      JSON.stringify(local),
    );
  return root;
}

describe("machine-local Kitchen configuration", () => {
  it("switches global and station authors to Claude without inheriting Codex settings", () => {
    const previous = { provider: "codex", model: "codex-model", executable: "old-codex.exe", windowsSandbox: "unelevated" };
    const root = fixture({ providers: { author: previous }, stations: { spec: { author: previous } } }, { providers: { author: { provider: "claude", model: "claude-model" } }, stations: { spec: { author: { provider: "claude" } }, plan: { author: { model: "plan-model" } } } });
    expect(loadConfig(root).providers.author).toEqual({ provider: "claude", model: "claude-model" });
    expect(loadConfig(root).stations.spec?.author).toEqual({ provider: "claude" });
    expect(loadConfig(root).stations.plan?.author).toEqual({ provider: "claude", model: "plan-model" });
  });
  it.each([null, false, 0, []])(
    "rejects an invalid role override %j",
    (author) => {
      expect(() => loadConfig(fixture({}, { providers: { author } }))).toThrow(
        /configuration/i,
      );
    },
  );
  const deepseek = {
    provider: "deepseek",
    model: "kitchen-deepseek-r1:8b",
    dsh: {
      version: "0.2.2-alpha.3",
      baseURL: "http://127.0.0.1:11434/v1",
      contextWindow: 8192,
      maxTokens: 2048,
    },
  };
  it("validates opt-in token policy and merges role limits without mutating the shared configuration", () => {
    const selected = { ...deepseek, dsh: { ...deepseek.dsh, tokenPolicy: { version: 1, maxSteps: 4 } } };
    expect(loadConfig(fixture({ providers: { author: selected } }, { providers: { author: { dsh: { maxTokens: 1024 } } } })).providers.author.dsh).toEqual({ ...selected.dsh, maxTokens: 1024 });
    expect(() => loadConfig(fixture({ providers: { author: { ...selected, dsh: { ...selected.dsh, tokenPolicy: { version: 1, maxSteps: -1 } } } } }))).toThrow(/token policy/);
  });
  it("replaces Codex-specific settings on a DeepSeek provider switch", () => {
    const root = fixture(
      {
        providers: {
          author: {
            provider: "codex",
            model: "gpt",
            executable: "old-codex.exe",
            windowsSandbox: "elevated",
          },
        },
      },
      {
        providers: { author: deepseek },
        stations: { plan: { author: deepseek } },
      },
    );
    expect(loadConfig(root).providers.author).toEqual(deepseek);
    expect(loadConfig(root).stations.plan?.author).toEqual(deepseek);
  });
  it("merges nested DSH settings and drops them when switching back to Codex", () => {
    const root = fixture(
      {
        providers: { author: deepseek },
        stations: { plan: { author: deepseek } },
      },
      {
        providers: { author: { dsh: { maxTokens: 1024 } } },
        stations: { plan: { author: { provider: "codex" } } },
      },
    );
    expect(loadConfig(root).providers.author.dsh).toEqual({
      ...deepseek.dsh,
      maxTokens: 1024,
    });
    expect(loadConfig(root).stations.plan?.author).toEqual({
      provider: "codex",
    });
  });
  it.each([
    { ...deepseek, model: undefined },
    { ...deepseek, model: "deepseek:cloud" },
    { ...deepseek, windowsSandbox: "unelevated" },
    ...["latest", "next", "^0.2.2", "0.2.2;echo"].map((version) => ({
      ...deepseek,
      dsh: { ...deepseek.dsh, version },
    })),
    ...[
      "https://api.deepseek.com/v1",
      "http://localhost:11434/v1",
      "http://127.0.0.1:11434/v1?proxy=x",
      "http://user:password@127.0.0.1/v1",
    ].map((baseURL) => ({ ...deepseek, dsh: { ...deepseek.dsh, baseURL } })),
    { ...deepseek, dsh: { ...deepseek.dsh, maxTokens: 8192 } },
    { ...deepseek, dsh: { ...deepseek.dsh, maxTokens: 0 } },
    { ...deepseek, dsh: { ...deepseek.dsh, contextWindow: 1.5 } },
    {
      ...deepseek,
      dsh: { ...deepseek.dsh, expectedModelDigest: "unverified" },
    },
    { provider: "claude", dsh: deepseek.dsh },
  ])("rejects unsupported DeepSeek settings %#", (author) => {
    expect(() => loadConfig(fixture({ providers: { author } }))).toThrow(
      /configuration/i,
    );
  });
  it.each([
    "origin/main",
    "origin/release/next",
    "main",
    "refs/heads/trunk",
    "refs/remotes/origin/master",
  ])("accepts a project's base branch: %s", (base) => {
    expect(loadConfig(fixture({ base })).base).toBe(base);
  });
  it.each([
    "",
    "HEAD",
    "origin/HEAD",
    "--all",
    "main~1",
    "origin/../main",
    "main:other",
    null,
    42,
  ])("rejects invalid base branches: %s", (base) => {
    expect(() => loadConfig(fixture({ base }))).toThrow(/Base must name/);
  });
  it("requires an explicit review opt-in even when a reviewer is configured", () => {
    const config = loadConfig(
      fixture({ stations: { spec: { review: { provider: "claude" } } } }),
    );
    for (const station of stationOrder)
      expect(config.stations[station]?.reviewEnabled ?? false).toBe(false);
  });
  it.each(stationOrder)(
    "merges the %s review opt-in with local settings",
    (station) => {
      const root = fixture(
        {
          stations: {
            [station]: {
              reviewEnabled: true,
              review: { provider: "claude", model: "review-model" },
            },
          },
        },
        { stations: { [station]: { reviewEnabled: false } } },
      );
      expect(loadConfig(root).stations[station]).toEqual({
        reviewEnabled: false,
        review: { provider: "claude", model: "review-model" },
      });
      writeFileSync(
        path.join(root, "kitchen.config.local.json"),
        JSON.stringify({
          stations: { [station]: { review: { model: "local-model" } } },
        }),
      );
      expect(loadConfig(root).stations[station]).toEqual({
        reviewEnabled: true,
        review: { provider: "claude", model: "local-model" },
      });
    },
  );
  it.each(["true", 1, null, {}])(
    "rejects non-boolean review opt-ins: %j",
    (reviewEnabled) => {
      expect(() =>
        loadConfig(fixture({ stations: { spec: { reviewEnabled } } })),
      ).toThrow(/reviewEnabled must be a boolean/);
    },
  );
  it("merges a local Windows sandbox selection with the shared Codex settings", () => {
    const root = fixture(
      { providers: { author: { provider: "codex", model: "shared-model" } } },
      {
        providers: { author: { windowsSandbox: "unelevated" } },
        stations: {
          spec: { review: { provider: "codex", windowsSandbox: "elevated" } },
        },
      },
    );
    expect(loadConfig(root).providers.author).toMatchObject({
      provider: "codex",
      model: "shared-model",
      windowsSandbox: "unelevated",
    });
    expect(loadConfig(root).stations.spec?.review?.windowsSandbox).toBe(
      "elevated",
    );
  });
  it.each([
    { provider: "codex", windowsSandbox: "disabled" },
    { provider: "codex", windowsSandbox: null },
    { provider: "claude", windowsSandbox: "unelevated" },
  ])("rejects invalid or unsupported sandbox configuration: %j", (author) => {
    expect(() => loadConfig(fixture({ providers: { author } }))).toThrow(
      /provider configuration/i,
    );
  });
  it("selects a local runtime while retaining shared model, reviewer and timeout", () => {
    const shared = {
      providers: {
        author: { provider: "codex", model: "shared-model" },
        review: { provider: "claude", model: "review-model" },
        timeoutMs: 12345,
      },
      github: { repository: "example/project" },
    };
    const root = fixture(shared, {
      providers: { author: { executable: "C:/Codex App/codex.exe" } },
    });
    expect(loadConfig(root)).toMatchObject({
      providers: {
        author: {
          provider: "codex",
          model: "shared-model",
          executable: "C:/Codex App/codex.exe",
        },
        review: shared.providers.review,
        timeoutMs: 12345,
      },
      github: shared.github,
    });
  });

  it("merges station role overrides and preserves other configured roles", () => {
    const root = fixture(
      {
        stations: {
          spec: {
            author: { provider: "claude", model: "spec-model" },
            review: { provider: "codex", model: "review-model" },
          },
        },
      },
      {
        stations: {
          spec: { review: { executable: "C:/Codex App/codex.exe" } },
          plan: { author: { model: "local-model" } },
        },
      },
    );
    expect(loadConfig(root).stations).toEqual({
      spec: {
        author: { provider: "claude", model: "spec-model" },
        review: {
          provider: "codex",
          model: "review-model",
          executable: "C:/Codex App/codex.exe",
        },
      },
      plan: { author: { provider: "codex", model: "local-model" } },
    });
  });

  it("validates local overrides rather than silently using the shared model", () => {
    const root = fixture({}, { providers: { author: { model: "" } } });
    expect(() => loadConfig(root)).toThrow(/provider configuration/i);
  });

  it("keeps CLI defaults when no local file exists", () => {
    expect(loadConfig(fixture({})).providers).toEqual({
      author: { provider: "codex" },
      review: { provider: "claude" },
      timeoutMs: 600000,
    });
  });
  it("merges discovery roles and rejects unsupported session reuse", () => {
    const root = fixture({ discovery: { enabled: true, author: { provider: "claude", model: "reader" } } },
      { discovery: { author: { executable: "reader-cli" } } });
    expect(loadConfig(root).discovery).toEqual({ enabled: true, author: { provider: "claude", model: "reader", executable: "reader-cli" } });
    expect(() => loadConfig(fixture({ providers: { author: { provider: "codex", sessionReuse: "after-input" } } }))).toThrow(/provider configuration/);
    expect(loadConfig(fixture({ providers: { author: { provider: "claude", sessionReuse: "never" } } })).providers.author.sessionReuse).toBe("never");
  });
});
