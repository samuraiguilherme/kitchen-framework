import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { safePath } from "../src/domain.ts";

describe("filesystem boundaries", () => {
it("rejects a parent symlink leading outside the worktree", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-path-"));
    const outside = mkdtempSync(path.join(tmpdir(), "kitchen-outside-"));
    mkdirSync(path.join(root, "src"));
    symlinkSync(outside, path.join(root, "src/link"), "junction");
    expect(() => safePath(root, "src/link/file.ts")).toThrow();
  });
});
