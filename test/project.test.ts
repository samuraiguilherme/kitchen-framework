import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject, projectRoot } from "../src/project.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: "pipe",
}).trim();

function fixture(separate = false) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "kitchen-project-")));
  const root = path.join(directory, "checkout");
  mkdirSync(root);
  git(root, "init", "--initial-branch=trunk", ...(separate ? ["--separate-git-dir", path.join(directory, "metadata")] : []));
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "baseline");
  return { root, directory, commit: git(root, "rev-parse", "HEAD") };
}

describe("project initialization", () => {
  it("uses the current local branch without a remote or package.json", async () => {
    const { root } = fixture();
    expect(await initializeProject(root)).toMatchObject({ base: "trunk" });
    expect(existsSync(path.join(root, "package.json"))).toBe(false);
  });

  it.each(["origin/main", "origin/master", "origin/develop"])("detects an existing remote base: %s", async (ref) => {
    const { root, commit } = fixture();
    git(root, "update-ref", `refs/remotes/${ref}`, commit);
    expect((await initializeProject(root)).base).toBe(ref);
  });

  it("honors an explicit base and rejects missing refs before writing config", async () => {
    const { root, commit } = fixture();
    await expect(initializeProject(root, { base: "origin/missing" })).rejects.toThrow(/does not resolve/);
    expect(existsSync(path.join(root, "kitchen.config.json"))).toBe(false);
    git(root, "update-ref", "refs/remotes/origin/release/next", commit);
    expect((await initializeProject(root, { base: "origin/release/next" })).base).toBe("origin/release/next");
    await expect(initializeProject(root, { base: "trunk" })).rejects.toThrow(/already exists/);
  });

  it("resolves subdirectories and linked worktrees with a separate Git directory", async () => {
    const { root, directory } = fixture(true);
    const nested = path.join(root, "subdirectory");
    mkdirSync(nested);
    const linked = path.join(directory, "linked");
    git(root, "worktree", "add", "-b", "feature", linked);
    expect(await projectRoot(nested)).toBe(root);
    await expect(projectRoot(linked)).rejects.toThrow(/Cannot locate the main checkout/);
    git(root, "config", "core.worktree", root.replaceAll("\\", "/"));
    expect(await projectRoot(linked)).toBe(root);
  });
});
