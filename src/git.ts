import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execute } from "./process.ts";
import { digest, safePath } from "./domain.ts";

export const git = (root: string, ...args: string[]) =>
  execute("git", args, root);
export async function sourceFiles(
  root: string,
  feature: string,
): Promise<string[]> {
  const files = (
    await git(
      root,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    )
  )
    .split("\0")
    .filter(Boolean);
  return [...new Set(files)].filter(
    (file) =>
      file !== `docs/features/${feature}/verification.md` &&
      !file
        .split("/")
        .some((s) =>
          /^(\.git|\.kitchen|\.codex|\.claude|\.agents|node_modules|\.env(?:\..*)?)$/i.test(
            s,
          ),
        ),
  );
}
export async function sourceFingerprint(
  root: string,
  feature: string,
): Promise<string> {
  return digest(root, await sourceFiles(root, feature));
}
export async function commitFiles(
  root: string,
  files: string[],
  message: string,
): Promise<string> {
  for (const file of files) safePath(root, file);
  // Reject foreign staging so the runner cannot accidentally commit unrelated edits.
  const staged = (await git(root, "diff", "--cached", "--name-only", "-z"))
    .split("\0")
    .filter(Boolean);
  if (staged.some((file) => !files.includes(file)))
    throw new Error(
      "Unrelated staged changes must be removed from the index before a kitchen commit.",
    );
  if (files.length) await git(root, "add", "--", ...files);
  const changed = await git(root, "diff", "--cached", "--name-only");
  if (changed)
    await git(root, "-c", "core.hooksPath=", "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
export async function createWorktree(
  root: string,
  feature: string,
  base: string,
): Promise<{ worktree: string; branch: string }> {
  const worktree = path.join(root, ".kitchen", "worktrees", feature);
  const branch = `codex/kitchen/${feature}`;
  mkdirSync(path.dirname(worktree), { recursive: true });
  if (existsSync(worktree)) {
    if ((await git(worktree, "branch", "--show-current")) !== branch)
      throw new Error("Existing worktree has a different branch.");
    return { worktree, branch };
  }
  // A previously created branch can be recovered only if it is still at the recorded base.
  let existing = "";
  try {
    existing = await git(root, "rev-parse", "--verify", `refs/heads/${branch}`);
  } catch {
    /* new branch */
  }
  if (existing && existing !== base)
    throw new Error(
      "Existing feature branch has work; recover its state instead of replacing it.",
    );
  await git(
    root,
    "worktree",
    "add",
    ...(existing ? [] : ["-b", branch]),
    worktree,
    existing ? branch : base,
  );
  return { worktree, branch };
}
export async function baselineWorktree(
  root: string,
  base: string,
  target: string,
  candidate: string,
  files: string[],
  scaffoldContents: Record<string, string> = {},
): Promise<string> {
  await git(root, "worktree", "add", "--detach", target, base);
  // Only accepted tests and interface scaffolds enter the pre-implementation baseline.
  for (const file of files) {
    const source = safePath(candidate, file);
    const destination = safePath(target, file);
    if (!existsSync(source)) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, scaffoldContents[file] ?? readFileSync(source));
  }
  return target;
}
