import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { runProcess } from "./process.ts";
import type { CheckResult } from "./types.ts";

export async function doctor(root: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push({
    id: "node-22",
    required: true,
    status: process.versions.node.split(".")[0] === "22" ? "passed" : "failed",
    reason: process.versions.node,
  });
  const config = loadConfig(root);
  const packageFile = path.join(root, "package.json");
  const pinned = existsSync(packageFile)
    ? JSON.parse(readFileSync(packageFile, "utf8")).packageManager?.replace(
        /^pnpm@/,
        "",
      )
    : undefined;
  const checks = [
    { id: "pnpm", command: "pnpm", args: ["--version"], required: true },
    { id: "git", command: "git", args: ["--version"], required: true },
    {
      id: "base",
      command: "git",
      args: ["rev-parse", "--verify", config.base],
      required: true,
    },
    { id: "codex-cli", command: "codex", args: ["--version"], required: true },
    {
      id: "codex-auth",
      command: "codex",
      args: ["login", "status"],
      required: true,
    },
    {
      id: "claude-cli",
      command: "claude",
      args: ["--version"],
      required: true,
    },
    {
      id: "claude-auth",
      command: "claude",
      args: ["auth", "status", "--json"],
      required: true,
    },
    {
      id: "github-auth",
      command: "gh",
      args: ["api", "user", "--jq", ".login", "--hostname", "github.com"],
      required: false,
    },
  ];
  const settled = await Promise.allSettled(
    checks.map(async (check) => {
      const result = await runProcess({
        ...check,
        cwd: root,
        timeoutMs: 10000,
      });
      const failed =
        result.code !== 0 ||
        (check.id === "pnpm" && result.stdout.trim() !== pinned);
      let reason = failed
        ? result.timedOut
          ? "Timed out; inspect CLI availability/authentication."
          : "Command unavailable, authentication failed, or pinned version differs."
        : result.stdout.trim().slice(0, 200) || "Available";
      let status = failed ? "failed" : "passed";
      if (
        check.id === "github-auth" &&
        result.code === 0 &&
        config.github.account &&
        result.stdout.trim() !== config.github.account
      ) {
        status = "failed";
        reason = "Active account differs from configured intended username.";
      }
      if (check.id === "claude-auth" && result.code === 0) {
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
      "Copy/configure kitchen.config.example.json; profiles are required before the test plan.",
  });
  return results;
}
