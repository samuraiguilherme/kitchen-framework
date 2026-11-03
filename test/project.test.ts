import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  it("selects Claude author and Codex reviewer without enabling review", async () => {
    const { root } = fixture();
    const result = await initializeProject(root, { author: "claude", review: "codex" });
    expect(result).toMatchObject({ author: "claude", review: "codex" });
    const file = path.join(root, "kitchen.config.json");
    const original = readFileSync(file, "utf8");
    expect(JSON.parse(original)).toMatchObject({
      providers: { author: { provider: "claude" }, review: { provider: "codex" } },
      stations: {},
    });
    expect((await initializeProject(root, { author: "claude", review: "codex" })).created).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it.each(["author", "review"] as const)("rejects invalid %s selection before writing", async (role) => {
    const { root } = fixture();
    await expect(initializeProject(root, { [role]: "deepseek" })).rejects.toThrow(/codex.*claude/);
    expect(existsSync(path.join(root, "kitchen.config.json"))).toBe(false);
    expect(existsSync(path.join(root, "docs"))).toBe(false);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
  });

  it("checks effective local roles before any initialization writes", async () => {
    const { root } = fixture();
    writeFileSync(path.join(root, "kitchen.config.local.json"), JSON.stringify({ providers: { author: { provider: "codex" } } }));
    await expect(initializeProject(root, { author: "claude" })).rejects.toThrow(/providers.author/);
    expect(existsSync(path.join(root, "kitchen.config.json"))).toBe(false);
    expect(existsSync(path.join(root, "docs"))).toBe(false);
    const result = await initializeProject(root, { author: "codex" });
    expect(result).toMatchObject({ author: "codex", review: "claude" });
    const shared = readFileSync(path.join(root, "kitchen.config.json"), "utf8");
    await expect(initializeProject(root, { review: "codex" })).rejects.toThrow(/providers.review/);
    expect(readFileSync(path.join(root, "kitchen.config.json"), "utf8")).toBe(shared);
  });

  it("validates local provider-specific fields against the selected new author before writing", async () => {
    const { root } = fixture();
    writeFileSync(path.join(root, "kitchen.config.local.json"), JSON.stringify({ providers: { author: { windowsSandbox: "unelevated" } } }));
    await expect(initializeProject(root, { author: "claude" })).rejects.toThrow(/provider configuration/);
    expect(existsSync(path.join(root, "kitchen.config.json"))).toBe(false);
  });

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
