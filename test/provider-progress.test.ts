import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { providerProgress } from "../src/provider-progress.ts";
import type { ProviderRequest } from "../src/types.ts";

vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
afterEach(() => vi.mocked(renameSync).mockReset());
function request(): ProviderRequest {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-live-lock-"));
  return { station: "plan", role: "review", prompt: "", cwd: root, runDir: root,
    timeoutMs: 1000, config: { provider: "deepseek" } };
}
describe("live progress snapshots", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retains raw events and continues through a transient %s lock", code => {
    vi.mocked(renameSync).mockImplementation(() => { throw Object.assign(new Error("locked"), { code }); });
    const req = request();
    const progress = providerProgress(req);
    const raw = '{"type":"session","sessionId":"s"}\n';
    expect(progress.capture("stdout", raw)).toBeUndefined();
    expect(readFileSync(path.join(req.runDir, "review-events.jsonl"), "utf8")).toBe(raw);
    expect(progress.metrics().sessionId).toBe("s");
    expect(() => progress.checkpoint()).not.toThrow();
  });
  it("still fails on other checkpoint storage errors", () => {
    vi.mocked(renameSync).mockImplementation(() => { throw Object.assign(new Error("storage full"), { code: "ENOSPC" }); });
    expect(() => providerProgress(request())).toThrow("storage full");
  });
});
