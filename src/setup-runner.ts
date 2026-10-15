import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { hash } from "./domain.ts";
import { runProcess } from "./process.ts";
import type { ProcessResult } from "./process.ts";
import type { Profile } from "./types.ts";

interface SetupResult extends ProcessResult {
  cacheHit: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  identity?: string;
  pnpmVersion?: string;
  cachedFrom?: { startedAt: string; finishedAt: string };
}
interface CacheRecord {
  version: 1;
  identity: string;
  installation: string;
  result: SetupResult;
}
const excluded = new Set(["node_modules", ".git", ".kitchen"]);
const contentHash = (file: string) =>
  existsSync(file) ? hash(readFileSync(file)) : null;

// Expand workspace directory patterns, without descending through symlinks or
// dependency trees. Normal apps/* workspaces only inspect one directory level.
function expandDirectories(root: string, pattern: string): string[] {
  const segments = pattern.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment.includes(":")))
    throw new Error("Unsafe workspace package pattern.");
  const walk = (directory: string, remaining: string[]): string[] => {
    if (!remaining.length) return [directory];
    if (!existsSync(directory)) return [];
    const [segment, ...rest] = remaining;
    const children = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && !excluded.has(entry.name),
    );
    if (segment === "**")
      return [
        ...walk(directory, rest),
        ...children.flatMap((entry) =>
          walk(path.join(directory, entry.name), remaining),
        ),
      ];
    const matcher = new RegExp(
      "^" +
        segment!
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*")
          .replaceAll("?", ".") +
        "$",
    );
    return children
      .filter((entry) => matcher.test(entry.name))
      .flatMap((entry) => walk(path.join(directory, entry.name), rest));
  };
  return walk(root, segments);
}

function dependencyFiles(root: string, cwd: string): string[] {
  const workspace = path.join(root, "pnpm-workspace.yaml");
  const config = existsSync(workspace)
    ? (parse(readFileSync(workspace, "utf8")) as { packages?: string[] })
    : undefined;
  const directories = new Set([root, cwd]);
  for (const pattern of config?.packages ?? []) {
    // Include excluded packages too: hashing extra inputs is conservative.
    if (typeof pattern === "string" && !pattern.startsWith("!"))
      for (const directory of expandDirectories(root, pattern))
        directories.add(directory);
  }
  return [
    workspace,
    ...[...directories].flatMap((directory) =>
      [
        "package.json",
        "pnpm-lock.yaml",
        ".npmrc",
        "pnpmfile.cjs",
        ".pnpmfile.cjs",
      ].map((file) => path.join(directory, file)),
    ),
  ].sort();
}

function installationIdentity(root: string, cwd: string): string | undefined {
  const modules = path.join(root, "node_modules");
  if (!existsSync(modules) || !lstatSync(modules).isDirectory()) return;
  const marker = path.join(modules, ".modules.yaml");
  // A success code alone does not establish a reusable pnpm installation.
  if (!existsSync(marker)) return;
  return hash(
    JSON.stringify(
      [...new Set([modules, path.join(cwd, "node_modules")])].map(
        (directory) => [
          directory,
          existsSync(directory) ? readdirSync(directory).sort() : null,
          contentHash(path.join(directory, ".modules.yaml")),
          contentHash(path.join(directory, ".pnpm", "lock.yaml")),
        ],
      ),
    ),
  );
}

function cancelled(): ProcessResult {
  return { code: -1, stdout: "", stderr: "", timedOut: false, cancelled: true };
}

async function acquireLock(
  directory: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const token = randomUUID();
  const owner = path.join(directory, "owner.json");
  const deadline = performance.now() + timeoutMs;
  while (!signal?.aborted) {
    if (performance.now() >= deadline)
      throw new Error("Timed out waiting for workspace dependency setup lock.");
    try {
      mkdirSync(directory);
      writeFileSync(owner, JSON.stringify({ pid: process.pid, token }));
      return () => {
        try {
          if (JSON.parse(readFileSync(owner, "utf8")).token === token) {
            unlinkSync(owner);
            rmdirSync(directory);
          }
        } catch {
          // A removed lock cannot authorize removing a replacement owner's lock.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const record = JSON.parse(readFileSync(owner, "utf8"));
        if (Number.isInteger(record.pid) && record.pid > 0) {
          try {
            process.kill(record.pid, 0);
          } catch (probe) {
            stale = (probe as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        // Another process can be between mkdir and recording ownership.
      }
      if (stale)
        throw new Error(
          `Stale workspace dependency setup lock: ${directory}. Inspect its owner before removing the lock.`,
        );
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 25);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }
}

/** Successful dependency setup is shared across checks, never behavioral RED. */
export async function executeSetup(input: {
  root: string;
  cwd: string;
  profile: Profile;
  signal?: AbortSignal;
}): Promise<SetupResult> {
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const finish = (
    result: ProcessResult,
    metadata: Partial<SetupResult> = {},
  ): SetupResult => ({
    ...result,
    cacheHit: false,
    ...metadata,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - start,
  });
  if (input.signal?.aborted) return finish(cancelled());
  const root = realpathSync(input.root);
  const cwd = realpathSync(input.cwd);
  const setup = input.profile.setup!;
  const directory = path.join(root, ".kitchen", "cache", "setup");
  mkdirSync(directory, { recursive: true });
  const release = await acquireLock(
    path.join(directory, "install.lock"),
    setup.timeoutMs + 10000,
    input.signal,
  );
  if (!release) return finish(cancelled());
  try {
    if (input.signal?.aborted) return finish(cancelled());
    const environment = Object.fromEntries(
      Object.entries({ ...process.env, ...input.profile.env }).sort(
        ([a], [b]) => a.localeCompare(b),
      ),
    );
    let pnpmVersion = "not-pnpm";
    if (/^pnpm(?:\.cmd|\.exe)?$/i.test(path.basename(setup.command))) {
      const identity = await runProcess({
        command: setup.command,
        args: ["--version"],
        cwd,
        timeoutMs: 10000,
        env: input.profile.env,
        signal: input.signal,
      });
      if (identity.code !== 0) return finish(identity);
      pnpmVersion = identity.stdout.trim();
    }
    const dependencies = () =>
      dependencyFiles(root, cwd).map((file) => [
        path.relative(root, file),
        contentHash(file),
      ]);
    const before = dependencies();
    const identity = hash(
      JSON.stringify({
        version: 1,
        root,
        cwd,
        runtime: {
          node: process.version,
          executable: process.execPath,
          platform: process.platform,
          arch: process.arch,
          pnpmVersion,
        },
        dependencies: before,
        environment,
        setup,
      }),
    );
    const file = path.join(directory, `${identity}.json`);
    const installation = installationIdentity(root, cwd);
    if (installation) {
      try {
        const cached: CacheRecord = JSON.parse(readFileSync(file, "utf8"));
        if (
          cached.version === 1 &&
          cached.identity === identity &&
          cached.installation === installation &&
          cached.result.code === 0 &&
          !cached.result.cancelled &&
          !cached.result.timedOut
        ) {
          return finish(cached.result, {
            cacheHit: true,
            identity,
            pnpmVersion,
            cachedFrom: {
              startedAt: cached.result.startedAt,
              finishedAt: cached.result.finishedAt,
            },
          });
        }
      } catch {
        // Missing or corrupt cache evidence requires a real setup.
      }
    }
    const execution = await runProcess({
      ...setup,
      cwd,
      env: input.profile.env,
      signal: input.signal,
    });
    if (input.signal?.aborted)
      return finish(
        { ...execution, code: -1, cancelled: true },
        { identity, pnpmVersion },
      );
    if (JSON.stringify(before) !== JSON.stringify(dependencies()))
      return finish(
        {
          ...execution,
          code: -1,
          failureReason: "Dependency inputs changed during setup.",
        },
        { identity, pnpmVersion },
      );
    const result = finish(execution, { identity, pnpmVersion });
    const afterInstallation = installationIdentity(root, cwd);
    if (
      result.code === 0 &&
      !result.cancelled &&
      !result.timedOut &&
      afterInstallation
    ) {
      // Readers hold the same workspace lock. A crash during this write leaves
      // invalid JSON, which is always treated as a cache miss on the next run.
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          identity,
          installation: afterInstallation,
          result,
        } satisfies CacheRecord),
      );
    }
    return result;
  } finally {
    release();
  }
}
