import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "../src/domain.ts";
import { replayStation, verifyReplayBundle } from "../src/replay.ts";
import type { ReplayManifest } from "../src/replay.ts";
import type { ProviderRequest } from "../src/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const candidate = { summary: "Intent", questions: [], document: "# Brand\n## What the product can't do today\nNeeds a visible test label.\n## Who is affected\nOperator.\n## What better looks like\nVisible subtitle.\n## Out of scope\nBackend.\n## Constraints\nOne static string.", files: [], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [] };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-replay-")); roots.push(root);
  const bundle = path.join(root, "bundle"); mkdirSync(path.join(bundle, "source/src"), { recursive: true });
  writeFileSync(path.join(bundle, "source/src/brand.tsx"), "original");
  const inputs = { "saved-prompt.txt": "saved request", "current-prompt.txt": "current request",
    "events.jsonl": "raw event log", "response.txt": JSON.stringify(candidate), "process.json": '{"code":0}' };
  for (const [file, content] of Object.entries(inputs)) writeFileSync(path.join(bundle, file), content);
  const manifest: ReplayManifest = { version: 1, capturedAt: "fixture", station: "intent", role: "author", feature: "demo",
    origin: { evidence: "original", configurationRoot: "project", worktree: "worktree", stateHash: "state" },
    recordedProvider: { provider: "codex" }, sourceAtCapture: "capture-fingerprint", files: { "src/brand.tsx": hash("original") },
    inputs: Object.fromEntries(Object.entries(inputs).map(([file, content]) => [file, hash(content)])),
    profiles: {}, acIds: [], config: { provider: "codex" }, timeoutMs: 1000 };
  writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(path.join(bundle, "manifest.sha256"), hash(JSON.stringify(manifest)));
  return { root, bundle, output: path.join(root, "result") };
}
describe("isolated station replay", () => {
  it("defaults to offline validation without a provider and never claims runtime qualification", async () => {
    const setup = fixture(); const provider = vi.fn();
    const result = await replayStation({ ...setup, provider });
    expect(result).toMatchObject({ valid: true, live: false, qualityQualified: false });
    expect(provider).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path.join(setup.output, "candidate.json"), "utf8"))).toEqual(candidate);
    await expect(replayStation(setup)).rejects.toThrow(/fresh output/);
  });
  it.each(["source/src/brand.tsx", "saved-prompt.txt", "events.jsonl", "manifest.json"])("rejects changed captured input %s before a provider call", async file => {
    const setup = fixture(); const provider = vi.fn();
    writeFileSync(path.join(setup.bundle, file), "changed");
    await expect(replayStation({ ...setup, live: true, provider })).rejects.toThrow(/changed/);
    expect(provider).not.toHaveBeenCalled();
  });
  it("uses a separate source copy and current prompt for explicit live experiments", async () => {
    const setup = fixture(); const provider = vi.fn(async (request: ProviderRequest) => {
      expect(request.cwd).toBe(path.join(setup.output, "source"));
      expect(request.prompt).toBe("current request");
      writeFileSync(path.join(request.cwd, "src/brand.tsx"), "unauthorized mutation");
      return candidate;
    });
    const result = await replayStation({ ...setup, live: true, mode: "current", provider });
    expect(result).toMatchObject({ valid: false, sourceUnchanged: false, qualityQualified: false });
    expect(verifyReplayBundle(setup.bundle).sourceAtCapture).toBe("capture-fingerprint");
    expect(readFileSync(path.join(setup.bundle, "source/src/brand.tsx"), "utf8")).toBe("original");
  });
  it("retains cancellation as failure and requires live opt-in for a rebuilt prompt", async () => {
    const setup = fixture();
    const result = await replayStation({ ...setup, live: true, provider: async () => { throw new Error("cancelled"); } });
    expect(result).toMatchObject({ valid: false, issues: ["cancelled"] });
    await expect(replayStation({ ...fixture(), mode: "current" })).rejects.toThrow(/requires --live/);
    const nested = fixture();
    await expect(replayStation({ ...nested, output: path.join(nested.bundle, "nested") })).rejects.toThrow(/outside the captured/);
  });
});
