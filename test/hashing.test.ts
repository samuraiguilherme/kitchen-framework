import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digest, hash, safePath } from "../src/domain.ts";
import { sourceFiles, sourceFingerprint, sourceSnapshot } from "../src/git.ts";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-hashing-"));
  roots.push(root);
  return root;
};
const write = (root: string, file: string, contents: string | Buffer) => {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
};
const legacyDigest = (root: string, files: string[]) =>
  hash(
    JSON.stringify(
      [...new Set(files)].sort().map((file) => [
        file,
        existsSync(safePath(root, file))
          ? hash(readFileSync(safePath(root, file)))
          : null,
      ]),
    ),
  );

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("source hashing boundaries", () => {
  it("preserves the existing digest bytes for sorting, duplicates, binary files and missing paths", () => {
    const root = fixture();
    write(root, "src/one.ts", "export const answer = 42;\r\n");
    write(root, "src/nested/two.bin", Buffer.from([0, 1, 127, 128, 255]));
    const files = [
      "src/nested/two.bin",
      "src/not-created/yet.ts",
      "src/one.ts",
      "src/one.ts",
    ];
    expect(digest(root, files)).toBe(legacyDigest(root, files));
    expect(digest(path.join(root, "absent"), [])).toBe(legacyDigest(root, []));
  });

  it("rechecks edited, created and deleted files on every scan", () => {
    const root = fixture();
    const files = ["src/one.ts", "src/two.ts"];
    write(root, files[0]!, "one");
    const before = digest(root, files);
    write(root, files[0]!, "two");
    expect(digest(root, files)).not.toBe(before);
    expect(digest(root, files)).toBe(legacyDigest(root, files));
    write(root, files[0]!, "one");
    write(root, files[1]!, "new file");
    expect(digest(root, files)).not.toBe(before);
    rmSync(path.join(root, files[1]!));
    expect(digest(root, files)).toBe(before);
  });

  it.each([
    "../outside",
    "/outside",
    "C:\\outside",
    ".git/config",
    ".kitchen/state.json",
    ".env",
    "src/../../outside",
    "node_modules/a",
    ".claude/settings.json",
  ])("keeps rejecting unsafe digest paths: %s", (file) => {
    expect(() => digest(fixture(), [file])).toThrow();
  });

  it("preserves internal directory links and rejects leaf links and escaping parents", () => {
    const root = fixture();
    const outside = fixture();
    write(root, "inside/one.ts", "inside");
    write(outside, "one.ts", "outside");
    symlinkSync(path.join(root, "inside"), path.join(root, "alias"), "junction");
    expect(digest(root, ["alias/one.ts"])).toBe(
      legacyDigest(root, ["alias/one.ts"]),
    );
    expect(() => digest(root, ["alias"])).toThrow(/symlink/);
    rmSync(path.join(root, "alias"), { recursive: true });
    symlinkSync(outside, path.join(root, "alias"), "junction");
    expect(() => digest(root, ["alias/one.ts"])).toThrow(/escapes/);
    expect(() => digest(root, ["alias/not-created/yet.ts"])).toThrow(/escapes/);
  });

  it("includes untracked source and detects edits/deletions while excluding runner metadata", async () => {
    const root = fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    write(root, "src/tracked.ts", "tracked");
    execFileSync("git", ["add", "src/tracked.ts"], { cwd: root });
    const original = await sourceFingerprint(root, "sort-items");
    write(root, "src/untracked.ts", "untracked");
    expect(await sourceFiles(root, "sort-items")).toEqual(
      expect.arrayContaining(["src/tracked.ts", "src/untracked.ts"]),
    );
    const untracked = await sourceFingerprint(root, "sort-items");
    expect(untracked).not.toBe(original);
    write(root, "src/tracked.ts", "changed");
    expect(await sourceFingerprint(root, "sort-items")).not.toBe(untracked);
    rmSync(path.join(root, "src/tracked.ts"));
    const deleted = await sourceFingerprint(root, "sort-items");
    write(root, ".kitchen/evidence.json", "runner evidence");
    write(root, ".env.local", "local configuration");
    write(root, "docs/features/sort-items/verification.md", "report");
    expect(await sourceFingerprint(root, "sort-items")).toBe(deleted);
    expect(deleted).toBe(
      legacyDigest(root, await sourceFiles(root, "sort-items")),
    );
  });

  it("derives a code-only fingerprint and byte counts from the same complete source snapshot", async () => {
    const root = fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    write(root, "src/one.ts", "caf\u00e9");
    write(root, "docs/features/sort-items/intent.md", "initial intent");
    const initial = await sourceSnapshot(root, "sort-items");
    expect(initial.fingerprint).toBe(
      await sourceFingerprint(root, "sort-items"),
    );
    expect(initial.fingerprint).toBe(
      legacyDigest(root, await sourceFiles(root, "sort-items")),
    );
    expect(initial.fileCount).toBe(2);
    expect(initial.byteCount).toBe(Buffer.byteLength("caf\u00e9initial intent"));
    write(root, "docs/features/sort-items/intent.md", "revised intent");
    const revised = await sourceSnapshot(root, "sort-items");
    expect(revised.fingerprint).not.toBe(initial.fingerprint);
    expect(revised.codeFingerprint).toBe(initial.codeFingerprint);
    write(root, "docs/features/another-feature/intent.md", "other feature");
    const other = await sourceSnapshot(root, "sort-items");
    expect(other.codeFingerprint).not.toBe(revised.codeFingerprint);
    write(root, "src/one.ts", "changed");
    expect(
      (await sourceSnapshot(root, "sort-items")).codeFingerprint,
    ).not.toBe(other.codeFingerprint);
  });
});
