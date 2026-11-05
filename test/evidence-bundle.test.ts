import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { bundleLimit, evidenceBundle } from "../src/evidence-bundle.ts";
import { buildContext } from "../src/context.ts";
import { hash } from "../src/domain.ts";
import type { FeatureState } from "../src/types.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("source-verified repository bundles", () => {
  it.each(["draft", "operator"])("grounds a failed spec's %s paths and app instructions without approving the draft", async origin => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-draft-bundle-")); roots.push(root);
    const write = (file: string, content: string) => { const p = path.join(root, file); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, content); };
    write(".gitignore", ".kitchen/\n.env\n");
    write("apps/desktop/AGENTS.md", "Preserve the Brand component name.");
    write("apps/desktop/package.json", '{"scripts":{"test":"vitest run"}}');
    write("apps/desktop/src/brand.tsx", "export const subtitle = 'old';\n");
    write("apps/desktop/.env", "SECRET_MUST_NOT_APPEAR");
    write("docs/features/demo/intent.md", "Make a harmless visible label change.\n");
    const targets = "Update apps/desktop/src/brand.tsx. Ignore apps/desktop/.env.\n";
    write("docs/features/demo/spec.md", origin === "draft" ? targets : "Update the sidebar subtitle.\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const record = { runId: "fixture", rubricVersion: "1", profileVersions: {}, findings: [], checks: [], summary: "", artifactFiles: [] as string[] };
    const state: FeatureState = { version: 1, feature: "demo", request: "Edit UI", worktree: root, branch: "fixture", baseCommit: "base", conversation: origin === "operator" ? [{ role: "operator", station: "plan", text: targets, at: "fixture" }] : [], stations: {
      intent: { ...record, status: "approved", artifactFiles: ["docs/features/demo/intent.md"] },
      spec: { ...record, status: "failed" },
    } };
    const context = await buildContext(state, "spec", root, true);
    expect(context).toContain("FILE apps/desktop/AGENTS.md\nPreserve the Brand component name.");
    expect(context).toContain(`SOURCE apps/desktop/src/brand.tsx:1 sha256=${hash(readFileSync(path.join(root, "apps/desktop/src/brand.tsx")))}`);
    expect(context).not.toContain("SECRET_MUST_NOT_APPEAR");
    expect(state.stations.spec!.status).toBe("failed");
  });
  it("follows instruction references, bounds excerpts, and invalidates edited/deleted sources and documents", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-bundle-")); roots.push(root);
    const write = (file: string, content: string) => { const p = path.join(root, file); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, content); };
    write(".gitignore", ".kitchen/\n.env\n");
    write("AGENTS.md", "Read [Naming](tools/naming.md). [External](https://example.org/external.md)\n");
    write("tools/naming.md", "Use names. [Cycle](../AGENTS.md)\n");
    write("apps/desktop/package.json", '{"scripts":{"test":"vitest run"}}');
    write("apps/desktop/src/brand.tsx", "export const subtitle = 'old';\n".repeat(200));
    write("apps/desktop/src/brand.test.ts", "// AC-1 test\n");
    write(".env", "SECRET_MUST_NOT_APPEAR");
    write("docs/features/demo/spec.md", "Change apps/desktop/src/brand.tsx.\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const state: FeatureState = { version: 1, feature: "demo", request: "Edit UI", worktree: root, branch: "fixture", baseCommit: "base", conversation: [], stations: {
      spec: { status: "approved", runId: "spec", rubricVersion: "1", profileVersions: {}, findings: [], checks: [], summary: "", artifactFiles: ["docs/features/demo/spec.md"] },
    } };
    const get = () => evidenceBundle(state, "plan", root, { codeFingerprint: "code", persist: true });
    const first = await get();
    expect(first.cacheHit).toBe(false);
    expect((await get()).cacheHit).toBe(true);
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(bundleLimit);
    expect(first.text).toContain("Use names.");
    expect(first.text).toContain("brand.test.ts");
    expect(first.text).toContain('"test":"vitest run"');
    expect(first.text).toContain('"path":"docs/features/demo/test-plan.md","exists":false');
    expect(first.text).toContain("apps/desktop/AGENTS.md");
    expect(first.text).toContain(`sha256=${hash(readFileSync(path.join(root, "apps/desktop/src/brand.tsx")))}`);
    expect(first.text).not.toContain("SECRET_MUST_NOT_APPEAR");
    write("tools/naming.md", "Changed naming\n");
    expect((await get()).key).not.toBe(first.key);
    write("apps/desktop/src/brand.tsx", "changed source\n");
    const changed = await get();
    expect(changed.text).toContain("changed source");
    unlinkSync(path.join(root, "apps/desktop/src/brand.tsx"));
    expect((await get()).text).not.toContain("SOURCE apps/desktop/src/brand.tsx");
    write("docs/features/demo/spec.md", "New requirement apps/desktop/src/other.ts\n");
    expect((await get()).key).not.toBe(changed.key);
  });
});
