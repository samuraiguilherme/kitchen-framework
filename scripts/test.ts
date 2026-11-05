import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { integrationEnvironment } from "./lib/test-environment.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const [lane = "all", ...args] = process.argv.slice(2);
if (!["all", "core", "integration", "preflight", "live"].includes(lane))
  throw new Error("Use all, core, integration, preflight or live.");
if (lane === "live") {
  // The explicit --live boundary prevents an ordinary test command consuming
  // model time. Existing benchmark evidence is source inspection, not runtime proof.
  if (args.includes("--live")) {
    if (!args.includes("--config") && !args.some(arg => arg.startsWith("--config=")))
      throw new Error("Live qualification requires --config <pinned-config.json>.");
    const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "scripts/benchmark-deepseek-tokens.ts"), ...args],
      { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", error => { console.error(error); process.exitCode = 1; });
    child.once("exit", code => { process.exitCode = code ?? 1; });
  } else {
    if (args.length) throw new Error("Add --live to explicitly opt into model calls.");
    console.log("No live qualification requested. Use the paired benchmark and isolated station replay:");
    console.log("pnpm test:live --live --config <pinned-config.json> --iterations 3 --stop-on-failure");
    console.log("pnpm test:replay --bundle <capture> --live --output <new-directory>");
    console.log("Require runtime RED/GREEN and human semantic review before promoting a prompt or model change.");
  }
} else {
  if (lane !== "core") {
    const checks = await integrationEnvironment();
    const directory = path.join(root, ".kitchen/test-runs", randomUUID());
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "environment.json");
    writeFileSync(file, JSON.stringify({ node: process.version, platform: process.platform, at: new Date().toISOString(), checks }, null, 2));
    console.log(`Environment evidence: ${file}`);
    const failed = checks.filter(check => !check.passed);
    if (failed.length) {
      for (const check of failed) console.error(`INFRASTRUCTURE BLOCKED [${check.id}]: ${check.reason}`);
      console.error("No tests were skipped or marked passing. Run the required integration gate in an environment with these capabilities.");
      process.exitCode = 2;
    }
  }
  if (!process.exitCode && lane !== "preflight") {
    const env: NodeJS.ProcessEnv = { ...process.env, KITCHEN_TEST_LANE: lane, GIT_ALLOW_PROTOCOL: "file" };
    // Node 26's loader warning otherwise contaminates subprocess stderr fixtures.
    // Suppress just that warning, process-locally; preserve all other diagnostics.
    if (Number(process.versions.node.split(".")[0]) >= 26)
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --disable-warning=DEP0205`.trim();
    const child = spawn(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"),
      ...(args.includes("--watch") ? [] : ["run"]), ...args], { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.once("error", error => { console.error(error); process.exitCode = 1; });
    child.once("exit", code => { process.exitCode = code ?? 1; });
  }
}
