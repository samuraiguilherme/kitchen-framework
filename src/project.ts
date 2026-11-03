import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { baseBranch, loadConfig } from "./config.ts";
import { safePath } from "./domain.ts";
import { git } from "./git.ts";
import { assetsRoot } from "./prompts.ts";
import type { Config, ProviderName } from "./types.ts";

export async function projectRoot(cwd: string): Promise<string> {
  let top: string;
  try {
    top = await git(cwd, "rev-parse", "--show-toplevel");
  } catch {
    throw new Error(
      `No Git working repository found at ${cwd}. Run git init and create an initial commit first, or select a project with --cwd <path>.`,
    );
  }
  const common = path.resolve(top, await git(top, "rev-parse", "--git-common-dir"));
  const gitDirectory = await git(top, "rev-parse", "--absolute-git-dir");
  if (realpathSync(common) === realpathSync(gitDirectory)) return path.resolve(top);
  // Git lists the main worktree first. Its location is unreliable for a
  // separate Git directory unless the operator configured core.worktree.
  const worktrees = await git(top, "worktree", "list", "--porcelain", "-z");
  const first = worktrees.split("\0")[0];
  if (first?.startsWith("worktree ")) {
    const main = path.resolve(first.slice(9));
    if (realpathSync(main) !== realpathSync(common)) return main;
  }
  try {
    return path.resolve(common, await git(top, "config", "--get", "core.worktree"));
  } catch {
    throw new Error(
      "Cannot locate the main checkout from this linked worktree. Run Kitchen in the main checkout with --cwd, or configure Git core.worktree for the separate Git directory.",
    );
  }
}

async function existingCommit(root: string, ref: string): Promise<boolean> {
  try {
    await git(root, "rev-parse", "--verify", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

async function detectBase(root: string): Promise<string> {
  try {
    const head = await git(
      root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD",
    );
    if (await existingCommit(root, head)) return head;
  } catch {
    // A local repository or an unfetched origin may have no default remote ref.
  }
  for (const ref of ["origin/main", "origin/master", "origin/develop"])
    if (await existingCommit(root, ref)) return ref;
  try {
    const branch = await git(root, "symbolic-ref", "--short", "HEAD");
    if (await existingCommit(root, branch)) return branch;
  } catch {
    // Detached checkouts can still use an existing local default branch.
  }
  for (const ref of ["main", "master", "develop"])
    if (await existingCommit(root, ref)) return ref;
  throw new Error(
    "Cannot detect a base branch. Create an initial commit or fetch your base branch, then run kitchen init --base <branch>.",
  );
}

async function githubRepository(root: string): Promise<string> {
  try {
    const remote = await git(root, "remote", "get-url", "origin");
    return (
      /^(?:https:\/\/github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/\s]+\/[^/\s]+?)\/?$/.exec(
        remote.replace(/\.git\/?$/, ""),
      )?.[1] ?? ""
    );
  } catch {
    return "";
  }
}

export async function initializeProject(
  root: string,
  options: { base?: string; author?: string; review?: string } = {},
): Promise<{
  root: string;
  base: string;
  author: ProviderName;
  review: ProviderName;
  created: string[];
  preserved: string[];
}> {
  const created: string[] = [];
  const preserved: string[] = [];
  const configPath = safePath(root, "kitchen.config.json");
  if (options.base !== undefined) baseBranch(options.base);
  for (const role of ["author", "review"] as const)
    if (
      options[role] !== undefined &&
      !["codex", "claude"].includes(options[role]!)
    )
      throw new Error(
        `--${role} must select codex or claude. Configure DeepSeek with its model/runtime settings in kitchen.config.json.`,
      );
  const checkSelections = (effective: Config) => {
    for (const role of ["author", "review"] as const)
      if (
        options[role] !== undefined &&
        effective.providers[role].provider !== options[role]
      )
        throw new Error(
          `Provider selection conflicts with providers.${role}. Edit kitchen.config.json or kitchen.config.local.json to change the effective role.`,
        );
  };
  let config: Config;
  if (existsSync(configPath)) {
    config = loadConfig(root);
    if (options.base && options.base !== config.base)
      throw new Error(
        "kitchen.config.json already exists. Edit its base field to change the base branch.",
      );
    checkSelections(config);
    preserved.push("kitchen.config.json");
  } else {
    const base = options.base ?? (await detectBase(root));
    baseBranch(base);
    if (!(await existingCommit(root, base)))
      throw new Error(
        `Base ${base} does not resolve to a commit. Create or fetch that branch before initializing Kitchen.`,
      );
    const shared: Config = {
      version: 1,
      base,
      github: { repository: await githubRepository(root) },
      providers: {
        author: { provider: options.author === "claude" ? "claude" : "codex" },
        review: { provider: options.review === "codex" ? "codex" : "claude" },
        timeoutMs: 600000,
      },
      stations: {},
      profiles: {},
    };
    config = loadConfig(root, shared);
    checkSelections(config);
    writeFileSync(configPath, JSON.stringify(shared, null, 2) + "\n", {
      flag: "wx",
    });
    created.push("kitchen.config.json");
  }
  for (const station of ["intent", "spec", "plan", "test-plan"]) {
    const file = `docs/_templates/${station}.md`;
    const target = safePath(root, file);
    if (existsSync(target)) {
      preserved.push(file);
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      readFileSync(path.join(assetsRoot, "templates", `${station}.md`)),
      { flag: "wx" },
    );
    created.push(file);
  }
  const ignore = safePath(root, ".gitignore");
  const contents = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const lines = contents.split(/\r?\n/);
  const missing = ["/.kitchen/", "/kitchen.config.local.json"].filter(
    (entry) => !lines.includes(entry) && !lines.includes(entry.slice(1)),
  );
  if (missing.length) {
    const newline = contents.includes("\r\n") ? "\r\n" : "\n";
    writeFileSync(
      ignore,
      contents +
        (contents && !contents.endsWith("\n") ? newline : "") +
        missing.join(newline) + newline,
    );
    created.push(".gitignore (Kitchen entries)");
  } else preserved.push(".gitignore");
  return {
    root,
    base: config.base,
    author: config.providers.author.provider,
    review: config.providers.review.provider,
    created,
    preserved,
  };
}
