import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.ts";
import { stationOrder } from "./domain.ts";
import { runProcess } from "./process.ts";
import { probeProvider } from "./providers.ts";
import { resolveProviderExecutable } from "./provider-executable.ts";
import type { CheckResult, RoleConfig } from "./types.ts";

export async function doctor(
  root: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  } = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push({
    id: "node-22",
    required: true,
    status: Number(process.versions.node.split(".")[0]) >= 22 ? "passed" : "failed",
    reason: process.versions.node,
  });
  const config = loadConfig(root);
  const pairs: Array<{
    config: RoleConfig;
    roles: string[];
    prerequisites: string[];
  }> = [];
  const addPair = (role: RoleConfig, label: string) => {
    const existing = pairs.find(
      (pair) =>
        pair.config.provider === role.provider &&
        pair.config.model === role.model &&
        pair.config.executable === role.executable &&
        pair.config.windowsSandbox === role.windowsSandbox,
    );
    if (existing) {
      if (!existing.roles.includes(label)) existing.roles.push(label);
    } else pairs.push({ config: role, roles: [label], prerequisites: [] });
  };
  for (const station of stationOrder) {
    const roles = config.stations[station];
    if (station !== "publish")
      addPair(
        roles?.author ?? config.providers.author,
        roles?.author ? `stations.${station}.author` : "providers.author",
      );
    if (roles?.reviewEnabled)
      addPair(
        roles.review ?? config.providers.review,
        roles.review ? `stations.${station}.review` : "providers.review",
      );
  }
  const packageFile = path.join(root, "package.json");
  const packageManager = existsSync(packageFile)
    ? JSON.parse(readFileSync(packageFile, "utf8")).packageManager
    : undefined;
  const pinned =
    typeof packageManager === "string" && packageManager.startsWith("pnpm@")
      ? packageManager.slice(5).split("+")[0]
      : undefined;
  const needsPnpm =
    pinned !== undefined || Object.values(config.profiles).some((profile) =>
      [
        profile.command,
        profile.setup?.command,
        profile.preview?.command,
        profile.preview?.build.command,
      ].includes("pnpm"),
    );
  const checks = [
    ...(needsPnpm
      ? [{ id: "pnpm", command: "pnpm", args: ["--version"], required: true }]
      : []),
    { id: "git", command: "git", args: ["--version"], required: true },
    {
      id: "base",
      command: "git",
      args: ["rev-parse", "--verify", config.base],
      required: true,
    },
    {
      id: "github-auth",
      command: "gh",
      args: ["api", "user", "--jq", ".login", "--hostname", "github.com"],
      required: false,
    },
  ];
  const executables: Array<{
    provider: RoleConfig["provider"];
    command: string;
    prefix: string;
  }> = [];
  for (const pair of pairs) {
    const provider = pair.config.provider;
    const command = resolveProviderExecutable(provider, pair.config.executable);
    let entry = executables.find(
      (e) => e.provider === provider && e.command === command,
    );
    if (!entry) {
      const count = executables.filter((e) => e.provider === provider).length;
      entry = {
        provider,
        command,
        prefix: provider + (count ? `-${count + 1}` : ""),
      };
      executables.push(entry);
      checks.push(
        {
          id: `${entry.prefix}-cli`,
          command,
          args: ["--version"],
          required: true,
        },
        {
          id: `${entry.prefix}-auth`,
          command,
          args:
            provider === "codex"
              ? ["login", "status"]
              : ["auth", "status", "--json"],
          required: true,
        },
      );
    }
    pair.prerequisites = [`${entry.prefix}-cli`, `${entry.prefix}-auth`];
  }
  const settled = await Promise.allSettled(
    checks.map(async (check) => {
      const result = await runProcess({
        ...check,
        cwd: root,
        timeoutMs: 10000,
        signal: options.signal,
      });
      const failed =
        result.code !== 0 ||
        (check.id === "pnpm" &&
          pinned !== undefined && result.stdout.trim() !== pinned);
      let reason = failed
        ? result.timedOut
          ? "Timed out; inspect CLI availability/authentication."
          : "Command unavailable, authentication failed, or pinned version differs."
        : result.stdout.trim().slice(0, 200) || "Available";
      let status = failed ? "failed" : "passed";
      if (check.id.endsWith("-cli")) reason = `${check.command}: ${reason}`;
      if (
        check.id === "github-auth" &&
        result.code === 0 &&
        config.github.account &&
        result.stdout.trim() !== config.github.account
      ) {
        status = "failed";
        reason = "Active account differs from configured intended username.";
      }
      if (/^claude(?:-\d+)?-auth$/.test(check.id) && result.code === 0) {
        try {
          if (!JSON.parse(result.stdout).loggedIn) {
            status = "failed";
            reason = "Claude is not logged in.";
          }
        } catch {
          status = "unverified";
          reason = "Unknown Claude auth response.";
        }
      }
      return { id: check.id, required: check.required, status, reason };
    }),
  );
  for (let index = 0; index < settled.length; index++) {
    const result = settled[index]!;
    results.push(
      result.status === "fulfilled"
        ? result.value
        : {
            id: checks[index]!.id,
            required: checks[index]!.required,
            status: "failed",
            reason: "Diagnostic failed.",
          },
    );
  }
  const runDir = path.join(root, ".kitchen", "doctor", randomUUID());
  for (const [index, pair] of pairs.entries()) {
    const label = `${pair.config.provider} model=${pair.config.model ?? "CLI default (inherited)"}${pair.config.provider === "codex" ? `; windowsSandbox=${pair.config.windowsSandbox ?? "CLI default (inherited)"}` : ""}; ${pair.roles.join(", ")}`;
    const check: CheckResult = {
      id: `${pair.config.provider}-model-${index + 1}`,
      required: true,
      status: "unverified",
    };
    const unavailable = pair.prerequisites.filter(
      (id) => results.find((r) => r.id === id)?.status !== "passed",
    );
    if (unavailable.length)
      check.reason = `${label}; request skipped because ${unavailable.join(", ")} did not pass.`;
    else if (options.signal?.aborted)
      check.reason = `${label}; cancelled before request.`;
    else {
      const probeDir = path.join(runDir, check.id);
      options.onProgress?.(
        `Checking ${label} with a small hosted request (uses model quota).`,
      );
      try {
        await probeProvider(
          pair.config,
          probeDir,
          Math.min(config.providers.timeoutMs, 60000),
          options.signal,
        );
        check.status = "passed";
        check.reason = `${label}; structured request succeeded.`;
      } catch (error) {
        check.status = "failed";
        check.reason = `${label}; ${error instanceof Error ? error.message : String(error)}`;
      }
      const evidence = path.join(probeDir, "review-process.json");
      if (existsSync(evidence)) check.evidence = evidence;
    }
    results.push(check);
  }
  results.push({
    id: "github-intended-account",
    required: false,
    status: config.github.account ? "passed" : "unverified",
    reason:
      config.github.account ??
      "Set an exact intended username before publishing.",
  });
  results.push({
    id: "check-profiles",
    required: false,
    status: Object.keys(config.profiles).length ? "passed" : "unverified",
    reason:
      Object.keys(config.profiles).join(", ") ||
      "Run kitchen init, then configure project-specific check profiles in kitchen.config.json before the test plan.",
  });
  return results;
}
