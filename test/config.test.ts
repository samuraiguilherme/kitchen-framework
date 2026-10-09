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
      github: { repository: "HireBus/hirebus-v3" },
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
});
