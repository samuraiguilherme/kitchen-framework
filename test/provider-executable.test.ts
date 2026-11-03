import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProviderExecutable } from "../src/provider-executable.ts";
import { providerInvocation } from "../src/providers.ts";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen codex update "));
  const bin = path.join(root, "OpenAI", "Codex", "bin");
  const missing = path.join(bin, "0000000000000000", "codex.exe");
  const runtime = (id: string, modified: number) => {
    const directory = path.join(bin, id);
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "codex.exe");
    writeFileSync(file, "fixture");
    utimesSync(file, modified, modified);
    return file;
  };
  return { bin, missing, runtime };
}

describe("Codex desktop executable resolution", () => {
  it("resolves a platform npx launcher for DeepSeek and preserves explicit paths", () => {
    expect(resolveProviderExecutable("deepseek")).toBe(
      process.platform === "win32" ? "npx.cmd" : "npx",
    );
    expect(
      resolveProviderExecutable("deepseek", "C:/Custom Runtime/npx.cmd"),
    ).toBe("C:/Custom Runtime/npx.cmd");
  });
  it("uses the app runtime on PATH after the configured runtime is removed", () => {
    const { bin, missing, runtime } = fixture();
    const active = runtime("1111111111111111", 1000);
    runtime("2222222222222222", 2000);
    const unrelated = path.join(path.dirname(bin), "other-cli");
    expect(
      resolveProviderExecutable(
        "codex",
        missing,
        [unrelated, `"${path.dirname(active)}"`].join(path.delimiter),
      ),
    ).toBe(active);
  });

  it("uses the newest complete sibling runtime when PATH has no app runtime", () => {
    const { bin, missing, runtime } = fixture();
    runtime("1111111111111111", 1000);
    const newest = runtime("2222222222222222", 2000);
    mkdirSync(path.join(bin, "3333333333333333"));
    expect(resolveProviderExecutable("codex", missing, "")).toBe(newest);
    expect(
      providerInvocation(
        "codex",
        "schema",
        "answer",
        "author",
        "model",
        missing,
      ).command,
    ).toBe(newest);
  });

  it("honors an existing explicit executable even when newer runtimes exist", () => {
    const { runtime } = fixture();
    const explicit = runtime("1111111111111111", 1000);
    const newer = runtime("2222222222222222", 2000);
    expect(
      resolveProviderExecutable("codex", explicit, path.dirname(newer)),
    ).toBe(explicit);
  });

  it("preserves missing custom paths, other providers, and CLI defaults", () => {
    const { bin, missing, runtime } = fixture();
    const installed = runtime("1111111111111111", 1000);
    const custom = path.join(bin, "custom", "codex.exe");
    expect(resolveProviderExecutable("codex", custom, "")).toBe(custom);
    expect(
      resolveProviderExecutable("claude", missing, path.dirname(installed)),
    ).toBe(missing);
    expect(resolveProviderExecutable("codex")).toBe("codex");
    expect(resolveProviderExecutable("claude")).toBe("claude");
  });

  it("retains the original missing path when no complete runtime is available", () => {
    const { bin, missing } = fixture();
    expect(resolveProviderExecutable("codex", missing, "")).toBe(missing);
    mkdirSync(path.join(bin, "1111111111111111"), { recursive: true });
    expect(resolveProviderExecutable("codex", missing, "")).toBe(missing);
  });
});
