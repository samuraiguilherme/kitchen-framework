// Offline prompt comparison by default. --live uses only the pinned local
// DeepSeek route; proposed source is inspected, never executed by this script.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { buildContext } from "../src/context.ts";
import { stationPrompt } from "../src/prompts.ts";
import { checkDeepSeekModel, deepseekSetupRole, prepareDeepSeek, validateDeepSeekConfig } from "../src/deepseek.ts";
import { authorSchema, cliProvider, intentAuthorSchema, reviewSchema } from "../src/providers.ts";
import { sourceSnapshot, git } from "../src/git.ts";
import { lintDocument } from "../src/domain.ts";
import type { AuthorOutput, FeatureState, ProviderMetrics, RoleConfig, Station, StationRecord } from "../src/types.ts";

const { values } = parseArgs({ options: {
  live: { type: "boolean", default: false }, iterations: { type: "string", default: "3" },
  model: { type: "string" }, output: { type: "string" }, cases: { type: "string" },
  config: { type: "string" },
  modes: { type: "string", default: "baseline,optimized" },
  "timeout-ms": { type: "string" }, "stop-on-failure": { type: "boolean", default: false },
} });
const supplied = values.config
  ? JSON.parse(readFileSync(path.resolve(values.config), "utf8"))
  : undefined;
const iterations = Number(values.iterations);
const timeoutMs = Number(values["timeout-ms"] ?? supplied?.providers?.timeoutMs ?? 180000);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000)
  throw new Error("Use 1–10 iterations and a timeout between 1000 and 3600000 ms.");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(root, values.output ?? `.kitchen/benchmarks/deepseek-tokens-${randomUUID()}`);
const fixture = path.join(directory, "fixture");
if (existsSync(fixture) || existsSync(path.join(directory, "report.json")))
  throw new Error("Benchmark output already exists. Choose a fresh --output directory to preserve previous evidence.");
mkdirSync(fixture, { recursive: true });
const write = (file: string, content: string) => {
  const absolute = path.join(fixture, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
};
const documents = {
  intent: "# Answer\n## What the product can't do today\nThe answer is wrong.\n## Who is affected\nLocal callers.\n## What better looks like\nReturn 42.\n## Out of scope\nOther functions.\n## Constraints\nAC-1: answer() returns exactly 42, takes no arguments, and makes no external requests.\n",
  spec: "# Answer\n## Summary\nFix answer.\n## Requirements and acceptance criteria\nAC-1: Given a caller, when answer() runs, then it returns exactly 42.\n## Roles and permissions\nLocal callers.\n## Business rules and edge cases\nEvery call returns 42. No arguments or external requests.\n## Non-goals\nOther functions.\n",
  plan: "# Answer plan\n## Description\nFix src/answer.js and test it.\n## Files to change\nsrc/answer.js and test/answer.test.js\n## Steps to implement\nWrite the unit assertion before fixing the answer.\n## Test plan\nSee test-plan.md.\n## Risks\nReturning 41 fails AC-1.\n",
  "test-plan": "# Answer test plan\n## Acceptance coverage\nAC-1: assert answer() equals 42.\n## Unit tests\ntest/answer.test.js uses node:test and node:assert/strict.\n## Regression\nRun all existing tests.\n## Required evidence\nRunner-owned behavioral RED then GREEN with nonzero executed tests.\n",
};
write("AGENTS.md", "Preserve AC-1 and all human answers. Propose complete file contents.\n");
write("src/answer.js", "export const answer = () => 41;\n");
write("test/answer.test.js", "import { answer } from '../src/answer.js';\nimport { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\ntest('AC-1', () => assert.equal(answer(), 42));\n");
write("package.json", '{"type":"module"}');
write(".gitignore", ".kitchen/\n");
write("kitchen.config.json", JSON.stringify({ profiles: { unit: { kind: "manual" }, unused: { kind: "manual" } } }));
for (const [name, content] of Object.entries(documents)) write(`docs/features/answer/${name}.md`, content);
await git(fixture, "init", "--quiet");
await git(fixture, "config", "user.name", "Kitchen benchmark");
await git(fixture, "config", "user.email", "benchmark@example.invalid");
await git(fixture, "add", ".");
await git(fixture, "commit", "--quiet", "-m", "Token benchmark fixture");
const baseCommit = await git(fixture, "rev-parse", "HEAD");
// Full candidate diff stays present in both modes.
write("src/answer.js", "export const answer = () => 41; // candidate still violates AC-1\n");
const empty: AuthorOutput = { summary: "", questions: [], document: null, files: [], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [] };
const record = (name: string): StationRecord => ({ status: "approved", runId: `fixture-${name}`, rubricVersion: "1.0.0", profileVersions: {}, summary: `Accepted ${name}.`, findings: [], checks: [], artifactFiles: [`docs/features/answer/${name}.md`], output: { ...empty, document: documents[name as keyof typeof documents] ?? null } });
type Case = { id: string; station: Station; role: "author" | "review"; feedback?: string; resource?: boolean; answered?: boolean; long?: boolean };
const allCases: Case[] = [
  { id: "intent-initial", station: "intent", role: "author" },
  { id: "intent-answered", station: "intent", role: "author", answered: true },
  { id: "plan-long-documents", station: "plan", role: "author", answered: true, long: true },
  { id: "unit-tests", station: "unit-tests", role: "author", answered: true },
  { id: "implementation", station: "implementation", role: "author", answered: true },
  { id: "review-seeded-defect", station: "verify", role: "review", answered: true },
  { id: "revision-conversation", station: "intent", role: "author", answered: true, feedback: "Keep AC-1: return exactly 42 with no arguments and no external requests." },
  { id: "oversized-context", station: "plan", role: "author", answered: true, resource: true },
];
const selected = values.cases ? values.cases.split(",") : allCases.map((item) => item.id);
if (selected.some((id) => !allCases.some((item) => item.id === id))) throw new Error("Unknown benchmark case.");
const cases = allCases.filter((item) => selected.includes(item.id));
const modes = values.modes!.split(",");
if (!modes.length || new Set(modes).size !== modes.length || modes.some((mode) => !["baseline", "optimized"].includes(mode)))
  throw new Error("Use --modes baseline,optimized or one of those modes.");
const role: RoleConfig = { ...(supplied ? supplied.providers?.author : deepseekSetupRole()), ...(values.model ? { model: values.model } : {}) };
validateDeepSeekConfig(role);
const requestedConfiguration = { author: structuredClone(role), timeoutMs };
let identity;
let capabilities: unknown;
let modelState: unknown;
if (values.live) {
  identity = await checkDeepSeekModel(role, 10000);
  role.dsh!.expectedModelDigest = identity.digest;
  const show = await fetch(new URL("/api/show", role.dsh!.baseURL), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: role.model }), signal: AbortSignal.timeout(10000), redirect: "error" });
  if (!show.ok) throw new Error(`Model capability check failed: HTTP ${show.status}`);
  const details = await show.json();
  capabilities = { capabilities: details.capabilities, thinking: details.thinking, parameters: details.parameters };
  const ps = await fetch(new URL("/api/ps", role.dsh!.baseURL), { signal: AbortSignal.timeout(10000), redirect: "error" });
  if (ps.ok) modelState = await ps.json();
}
const samples: Array<Record<string, unknown>> = [];
const source = await sourceSnapshot(root, "deepseek-token-benchmark");
const report = () => {
  const normal = samples.filter((sample) => !sample.resource);
  const groups = ["baseline", "optimized"].map((mode) => {
    const group = normal.filter((sample) => sample.mode === mode);
    const complete = group.length > 0 && group.every((sample) => sample.usageComplete === true);
    const knownTokens = group.reduce((sum, sample) => sum + Number(sample.knownTokens ?? 0), 0);
    const successes = group.filter((sample) => sample.correct === true).length;
    const successfulTokens = group.filter((sample) => sample.correct === true && typeof sample.tokens === "number").map((sample) => Number(sample.tokens)).sort((a, b) => a - b);
    const middle = Math.floor(successfulTokens.length / 2);
    const median = successfulTokens.length ? successfulTokens.length % 2 ? successfulTokens[middle] : (successfulTokens[middle - 1]! + successfulTokens[middle]!) / 2 : undefined;
    return { mode, attempts: group.length, successes, failures: group.filter((sample) => sample.correct === false).length, knownTokens, usageComplete: complete,
      promptBytes: group.reduce((sum, sample) => sum + Number(sample.promptBytes), 0),
      adapterInputBytes: group.reduce((sum, sample) => sum + Number(sample.adapterInputBytes), 0),
      tokensPerSuccess: complete && successes ? knownTokens / successes : null, medianSuccessfulTokens: median ?? null };
  });
  const [baseline, optimized] = groups;
  const allCorrect = groups.every((group) => group.attempts > 0 && group.attempts === group.successes && group.usageComplete);
  const fullCoverage = cases.length === allCases.length && normal.length === (allCases.length - 1) * iterations * 2;
  const resourcePassed = samples.some((sample) => sample.resource && sample.mode === "optimized" && sample.resourceResult === "rejected-without-truncation");
  const reduction = allCorrect && baseline!.medianSuccessfulTokens && optimized!.medianSuccessfulTokens
    ? 1 - optimized!.medianSuccessfulTokens / baseline!.medianSuccessfulTokens : null;
  const result = { live: values.live, iterations, requestedConfiguration, identity, capabilities, modelStateBefore: modelState,
    sourceFingerprint: source.fingerprint, cases: cases.map((item) => item.id),
    counting: "Provider-reported DSH input (including cache) + output; reasoning is included once. Offline bytes are not token counts.",
    correctnessScope: "Fixture requirements, document structure, proposed source inspection and seeded-defect detection. Model-proposed code is not executed.",
    summary: groups, medianReduction: reduction,
    adapterByteReduction: baseline!.attempts === optimized!.attempts && baseline!.adapterInputBytes ? 1 - optimized!.adapterInputBytes / baseline!.adapterInputBytes : null,
    promotionQualified: fullCoverage && resourcePassed && iterations >= 3 && allCorrect && reduction !== null && reduction >= 0.3,
    samples,
  };
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(result, null, 2));
  return result;
};
function correct(item: Case, output: unknown): boolean {
  const value = output as AuthorOutput & { findings?: Array<{ blocking: boolean; evidence: string; consequence: string }> };
  if (item.role === "review") return !!value.findings?.some((finding) => finding.blocking && /answer\.js/.test(finding.evidence) && /41|42/.test(finding.evidence + finding.consequence));
  if (item.id === "intent-initial") return value.questions.length > 0 && value.document === null && value.files.length === 0;
  if (item.station === "implementation") return value.questions.length === 0 && value.files.some((file) => file.path === "src/answer.js" && file.action === "write" && /export\s+(?:const|function)\s+answer/.test(file.content ?? "") && /(?:=>\s*42\b|return\s+42\b)/.test(file.content ?? ""));
  if (item.station === "unit-tests") return value.questions.length === 0 && value.files.some((file) => file.path === "test/answer.test.js" && file.kind === "test" && /AC-1/.test(file.content ?? "") && /assert\.(?:equal|strictEqual)\(\s*answer\(\),\s*42\s*\)/.test(file.content ?? ""));
  return value.questions.length === 0 && !!value.document && /42/.test(value.document) && lintDocument(item.station, value.document).length === 0;
}

let stopped = false;
for (const item of cases) {
  for (let iteration = 0; iteration < (item.resource ? 1 : iterations); iteration++) {
    // Alternate which mode runs first to reduce warm-order bias.
    for (const mode of (iteration % 2 ? ["optimized", "baseline"] : ["baseline", "optimized"]).filter((mode) => modes.includes(mode))) {
      if (stopped) break;
      const compact = mode === "optimized";
      const runDir = path.join(directory, item.id, `${iteration + 1}-${mode}`);
      const state: FeatureState = { version: 1, feature: "answer", request: item.answered ? "Fix answer() so AC-1 returns exactly 42 with no arguments and no external requests." : "Fix the answer function. Ask which return value is required before proposing a document.", baseCommit, branch: "fixture", worktree: fixture,
        stations: item.station === "intent" ? {} : Object.fromEntries(Object.keys(documents).map((name) => [name, record(name)])), conversation: [],
      };
      if (item.answered) state.conversation.push({ role: "operator", station: "intent", text: "AC-1: answer() takes no arguments, always returns exactly 42, and makes no external requests.", at: "fixture" });
      if (item.feedback) {
        for (let n = 0; n < 12; n++) state.conversation.push({ role: n % 2 ? "operator" : "model", station: "intent", text: n % 2 ? `Constraint ${n}: preserve AC-1.` : `Confirming AC-1 and asking for explicit approval ${n}.`, at: "fixture" });
        state.conversation.push({ role: "operator", station: item.station, text: item.feedback, at: "fixture" });
      }
      if (item.long || item.resource) write("docs/features/answer/spec.md", documents.spec + "\n" + "AC-1 applies to every invocation; preserve the existing export and local operation.\n".repeat(item.resource ? 1200 : 16));
      else write("docs/features/answer/spec.md", documents.spec);
      const intentFile = path.join(fixture, "docs/features/answer/intent.md");
      if (item.id === "intent-initial") {
        if (existsSync(intentFile)) unlinkSync(intentFile);
      } else write("docs/features/answer/intent.md", documents.intent);
      let context = await buildContext(state, item.station, fixture, compact);
      if (item.station === "unit-tests") context += "\nBENCHMARK TASK: propose only test/answer.test.js using node:test and node:assert/strict, test name AC-1, asserting assert.equal(answer(), 42). Do not implement src/answer.js. Runtime preparation for this source-inspection fixture is supplied; no runtime proof is requested.\n";
      if (item.station === "implementation") context += "\nBENCHMARK TASK: return the complete src/answer.js with its existing export fixed to return 42. allowedPaths includes only src/answer.js; unit tests are protected.\n";
      const prompt = stationPrompt(state, item.station, item.role, context, item.feedback, true, compact);
      const config: RoleConfig = { ...role, dsh: { ...role.dsh!, ...(compact ? { tokenPolicy: { version: 1, maxSteps: 8, maxToolCalls: 12, ...(item.resource ? { maxInputBytes: 16384 } : {}) } } : {}) } };
      const request = { station: item.station, role: item.role, cwd: fixture, runDir, prompt, timeoutMs, config };
      const schema = item.role === "review" ? reviewSchema
        : item.station === "intent" ? intentAuthorSchema : authorSchema;
      const invocation = prepareDeepSeek(request, schema);
      const sample: Record<string, unknown> = { id: item.id, station: item.station, role: item.role, mode, iteration: iteration + 1, resource: !!item.resource, promptBytes: Buffer.byteLength(prompt), adapterInputBytes: Buffer.byteLength(invocation.input), promptHash: createHash("sha256").update(prompt).digest("hex"), usageComplete: false };
      const metrics: ProviderMetrics[] = [];
      if (values.live) {
        if ((await sourceSnapshot(root, "deepseek-token-benchmark")).fingerprint !== source.fingerprint)
          throw new Error("Kitchen source changed during the benchmark; retain the evidence and start a fresh comparison.");
        const before = await sourceSnapshot(fixture, "answer");
        try {
          // The resource baseline is measured offline: avoid deliberately
          // sending a context known to exceed the installed allocation.
          if (item.resource && !compact) sample.resourceResult = "baseline-input-measured-offline";
          else {
            console.log(`${item.id} ${iteration + 1}/${iterations} ${mode}`);
            const output = await cliProvider({ ...request, onMetrics: (value) => metrics.push(value), onProgress: (message) => console.log(message) });
            sample.correct = !item.resource && correct(item, output);
            sample.output = output;
          }
        } catch (error) {
          sample.error = String(error);
          if (item.resource) sample.resourceResult = /input .*bytes exceeds/.test(String(error)) ? "rejected-without-truncation" : "unexpected-failure";
          else sample.correct = false;
        }
        if ((await sourceSnapshot(fixture, "answer")).fingerprint !== before.fingerprint) throw new Error("Provider modified the benchmark fixture outside Kitchen.");
        if ((await sourceSnapshot(root, "deepseek-token-benchmark")).fingerprint !== source.fingerprint)
          throw new Error("Kitchen source changed during the benchmark; retain the evidence and start a fresh comparison.");
        sample.metrics = metrics;
        sample.usageComplete = metrics.length > 0 && metrics.every((value) => value.tokens?.usageComplete);
        sample.knownTokens = metrics.reduce((sum, value) => sum + (value.tokens?.knownTotalTokens ?? 0), 0);
        if (sample.usageComplete) sample.tokens = sample.knownTokens;
        if (!item.resource && sample.correct === false && values["stop-on-failure"]) stopped = true;
      }
      samples.push(sample);
      report();
    }
  }
}
const result = report();
console.log(JSON.stringify({ report: path.join(directory, "report.json"), summary: result.summary, medianReduction: result.medianReduction, promotionQualified: result.promotionQualified }, null, 2));
if (values.live && result.samples.some((sample) => sample.correct === false || sample.resourceResult === "unexpected-failure")) process.exitCode = 1;
