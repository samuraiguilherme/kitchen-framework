import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { hash, stationOrder } from "../src/domain.ts";
import { doctor } from "../src/doctor.ts";
import { git, sourceSnapshot } from "../src/git.ts";
import { Kitchen } from "../src/kitchen.ts";
import { cliProvider, validateDiscoveryOutput } from "../src/providers.ts";
import { Storage } from "../src/storage.ts";
import type { CheckResult, Config, FeatureState, ProviderMetrics, Station } from "../src/types.ts";

const feature = "claude-smoke";
const installation = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(installation, "bin/kitchen.mjs");
const script = fileURLToPath(import.meta.url);

// This runtime executes the proposed assertions; it does not inspect source text
// to decide whether the behavior passes. Its JSON is consumed by Kitchen's parser.
const unitRunner = `import { pathToFileURL } from 'node:url';
const assertions = [];
for (const file of process.argv.slice(2)) {
  try {
    const { tests } = await import(pathToFileURL(file).href);
    if (!Array.isArray(tests) || !tests.length) throw new Error('No exported tests');
    for (const test of tests) {
      try { await test.run(); assertions.push({fullName:test.name,status:'passed',failureMessages:[]}); }
      catch (error) { assertions.push({fullName:test.name,status:'failed',failureMessages:[String(error.stack || error)]}); }
    }
  } catch (error) { console.error(error); process.exit(2); }
}
const failed = assertions.filter(test => test.status === 'failed').length;
console.log(JSON.stringify({numTotalTests:assertions.length,numPassedTests:assertions.length-failed,numFailedTests:failed,testResults:[{assertionResults:assertions}]}));
process.exitCode = failed || !assertions.length ? 1 : 0;
`;

export async function createSmokeProject(directory: string, roles: {
  model?: string; authorExecutable?: string; reviewExecutable?: string;
} = {}): Promise<string> {
  if (existsSync(directory) && readdirSync(directory).length)
    throw new Error("Smoke directory must be empty. Resume an existing fixture with --live --directory instead.");
  const project = path.join(directory, "project");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, ".gitignore"), ".kitchen/\nnode_modules/\nkitchen.config.local.json\n");
  writeFileSync(path.join(project, "src/answer.mjs"), "export function answer() { return 0; }\n");
  writeFileSync(path.join(project, "read-proof.txt"), randomUUID() + "\n");
  writeFileSync(path.join(project, "unit-runner.mjs"), unitRunner);
  writeFileSync(path.join(project, "AGENTS.md"), `This is a disposable Kitchen qualification project.
Keep function answer() in src/answer.mjs, with no side effects or dependencies.
Feature write scope is exactly src/answer.mjs and src/answer.test.mjs.
The unit profile runs unit-runner.mjs with the accepted test files.
Tests must be real node:assert/strict assertions. Each test file exports a nonempty
array named tests, whose entries have name (including AC-1) and async or sync run.
For example: import assert from 'node:assert/strict'; import { answer } from './answer.mjs';
export const tests = [{ name: 'AC-1 returns 42', run() { assert.equal(answer(), 42); } }];
No runtime preparation, scaffolds, integrations, browser or manual profiles are needed.
Use the existing unit profile with expectation red at baseline; require final GREEN.
`);
  const config: Config = {
    version: 1, base: "main", github: { repository: "" },
    providers: {
      author: { provider: "claude", ...(roles.model ? { model: roles.model } : {}), ...(roles.authorExecutable ? { executable: roles.authorExecutable } : {}) },
      review: { provider: "codex", ...(roles.reviewExecutable ? { executable: roles.reviewExecutable } : {}) },
      timeoutMs: 600000,
    },
    discovery: { enabled: true },
    stations: { verify: { reviewEnabled: true }, publish: { reviewEnabled: true } },
    profiles: { unit: { version: "1", kind: "unit", command: process.execPath, args: ["unit-runner.mjs", "{files}"], parser: "vitest-json", timeoutMs: 10000 } },
  };
  writeFileSync(path.join(project, "kitchen.config.json"), JSON.stringify(config, null, 2) + "\n");
  await git(project, "init", "--initial-branch=main");
  await git(project, "config", "user.name", "Kitchen Smoke");
  await git(project, "config", "user.email", "kitchen-smoke@example.test");
  await git(project, "config", "core.autocrlf", "false");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "Smoke baseline");
  return project;
}

interface SmokeReport {
  project: string;
  policy?: string;
  diagnostics?: CheckResult[];
  readProof?: { evidence: string; metrics?: ProviderMetrics };
  attempts: Array<{ at: string; station?: Station; status: string; error?: string }>;
  status?: string;
  stateFile?: string;
  qualification?: Record<string, boolean>;
}

function commands(project: string, station: Station) {
  const quote = (value: string) => process.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const prefix = `node ${quote(cli)} --cwd ${quote(project)}`;
  return {
    approve: `${prefix} approve ${feature} ${station} --actor <your-name>`,
    answer: `${prefix} run ${feature} ${station} --feedback-file <answers-file>`,
    resume: `node --import tsx ${quote(script)} --live --directory ${quote(path.dirname(project))}`,
  };
}

export function smokeQualification(state: FeatureState, config: Config, report: SmokeReport) {
  return {
    repositoryRead: !!report.readProof,
    questionsAndAnswers: state.conversation.some((message, index) =>
      message.role === "model" && state.conversation.slice(index + 1).some(answer =>
        answer.role === "operator" && answer.station === message.station)),
    baselineRed: state.stations["unit-tests"]?.checks.some(c => c.status === "expected-red") === true,
    implementationGreen: state.stations.implementation?.checks.some(c => c.required && c.status === "passed") === true,
    independentReview: (["verify", "publish"] as const).every(station =>
      state.stations[station]?.status === "approved" &&
      config.stations[station]?.reviewEnabled === true &&
      (config.stations[station]?.review ?? config.providers.review).provider === "codex"),
    approvedPreview: state.stations.publish?.status === "approved",
  };
}

async function runLive(directory: string, feedbackFile?: string) {
  const project = path.join(directory, "project");
  const reportFile = path.join(directory, "report.json");
  const report: SmokeReport = existsSync(reportFile)
    ? JSON.parse(readFileSync(reportFile, "utf8"))
    : { project, attempts: [] };
  if (report.project !== project) throw new Error("Smoke report belongs to another project.");
  const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let station: Station | undefined;
  try {
    const config = loadConfig(project);
    if (stationOrder.some(station => station !== "publish" &&
        (config.stations[station]?.author ?? config.providers.author).provider !== "claude"))
      throw new Error("All smoke author roles must select Claude.");
    const policy = hash(JSON.stringify(config));
    if (report.policy !== policy) {
      report.readProof = undefined;
      report.diagnostics = await doctor(project, { signal: controller.signal, onProgress: console.error });
      save();
      if (report.diagnostics.some(c => c.required && c.status !== "passed"))
        throw new Error("Required doctor checks did not pass; inspect report.json and retained evidence.");
      report.policy = policy;
      save();
    }
    if (!report.readProof) {
      const evidence = path.join(project, ".kitchen/read-proof", randomUUID());
      const before = await sourceSnapshot(project, feature);
      let metrics: ProviderMetrics | undefined;
      const output = validateDiscoveryOutput(await cliProvider({
        station: "plan", role: "author", kind: "discovery", cwd: project, runDir: evidence,
        config: config.providers.author, timeoutMs: config.providers.timeoutMs,
        signal: controller.signal, onProgress: console.error, onMetrics: value => { metrics = value; },
        prompt: 'Read read-proof.txt with the repository read tool. Return its exact trimmed contents as summary, one citation for read-proof.txt line 1 with hash="", and unresolved=[]. Do not write files or run commands.',
      }));
      if (output.summary !== readFileSync(path.join(project, "read-proof.txt"), "utf8").trim() ||
          output.evidence.length !== 1 || output.evidence[0]?.path !== "read-proof.txt" ||
          output.evidence[0]?.line !== 1 || output.unresolved.length ||
          (await sourceSnapshot(project, feature)).fingerprint !== before.fingerprint)
        throw new Error("Repository read proof failed; inspect retained provider output.");
      report.readProof = { evidence, metrics };
      save();
    }
    const kitchen = new Kitchen({ root: project });
    const storage = new Storage(project);
    if (!existsSync(storage.file(feature)))
      await kitchen.start(feature, { request: "Change answer() in src/answer.mjs to return 42 instead of 0, for every call, with no arguments or side effects. Before drafting intent, ask the human who will use this function. Their answer resolves the audience; do not ask it again. Keep the existing module API and follow AGENTS.md for the tests and exact scope." });
    let state = await kitchen.status(feature);
    report.stateFile = storage.file(feature);
    station = stationOrder.find(s => state.stations[s]?.status !== "approved");
    if (station && state.stations[station]?.status !== "awaiting-approval") {
      if (station === "publish") await kitchen.publish(feature, { preview: true, signal: controller.signal, onProgress: console.error });
      else await kitchen.run(feature, station, {
        signal: controller.signal, onProgress: console.error,
        ...(feedbackFile ? { feedback: readFileSync(feedbackFile, "utf8") } : {}),
      });
      state = await kitchen.status(feature);
    }
    report.qualification = smokeQualification(state, config, report);
    report.status = station ? state.stations[station]?.status : Object.values(report.qualification).every(Boolean) ? "qualified" : "incomplete-qualification";
    report.attempts.push({ at: new Date().toISOString(), station, status: report.status ?? "unknown" });
    save();
    const next = station ? commands(project, station) : undefined;
    console.log(JSON.stringify({ ...report, reportFile, next: next && {
      ...(report.status === "awaiting-input" ? { answer: next.answer } : {}),
      ...(report.status === "awaiting-approval" ? { approve: next.approve } : {}),
      resume: next.resume,
    } }, null, 2));
  } catch (error) {
    report.status = "failed";
    report.attempts.push({ at: new Date().toISOString(), station, status: "failed", error: error instanceof Error ? error.message : String(error) });
    save();
    throw error;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    init: { type: "boolean" }, live: { type: "boolean" }, directory: { type: "string" },
    model: { type: "string" }, "author-executable": { type: "string" },
    "review-executable": { type: "string" }, "feedback-file": { type: "string" },
  } });
  if (!values.init && !values.live) {
    console.log("Use --init to create a disposable project without provider calls. Use --live --directory <fixture-directory> to run or resume one station with real providers and human checkpoints. Optional --model/--author-executable/--review-executable apply during --init. Live mode consumes model quota and ends at the approved publish preview.");
    return;
  }
  if (!values.init && (values.model || values["author-executable"] || values["review-executable"]))
    throw new Error("Provider selection flags require --init; edit the fixture configuration to change existing roles.");
  if (values.live && !values.init && !values.directory)
    throw new Error("--live requires --directory pointing to an initialized smoke fixture.");
  const directory = path.resolve(values.directory ?? path.join(installation, ".kitchen/validation/claude-primary", randomUUID()));
  if (values.init) {
    const project = await createSmokeProject(directory, { model: values.model, authorExecutable: values["author-executable"], reviewExecutable: values["review-executable"] });
    console.log(JSON.stringify({ project, directory, next: commands(project, "intent").resume }, null, 2));
  }
  if (values.live) {
    if (!existsSync(path.join(directory, "project/.git")))
      throw new Error("Smoke project not found. Create it with --init first.");
    await runLive(directory, values["feedback-file"] ? path.resolve(values["feedback-file"]) : undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script)
  await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
