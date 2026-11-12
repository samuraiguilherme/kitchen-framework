import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acceptanceIds, gateReady } from "../../src/domain.ts";
import { git } from "../../src/git.ts";
import { runProcess } from "../../src/process.ts";
import type { AuthorOutput, Config, Provider, RoleConfig, Station, StationRecord } from "../../src/types.ts";

export const feature = "normalize-notifications";
export const request = "Normalize notification text in both the email and SMS packages. Keep the existing normalize(value) API. Return null for null or strings containing only whitespace, including the empty string. Preserve trimmed lowercase output for nonblank strings. Implement and test the packages independently. The fixture's AGENTS.md explains its check format and exact allowed files.";
const packages = ["email", "sms"] as const;
const modules = packages.map(name => `packages/${name}/normalize.mjs`);
const testFiles = packages.map(name => `packages/${name}/normalize.test.mjs`);
const scope = [...modules, ...testFiles];
const normalize = 'export function normalize(value) { if (value === null) return null; return value.trim().toLowerCase() || null; }\n';
const seededDefect = normalize.replace("return null;", 'return "";');
const pinnedTests = [ [" \t", null], ["  MiXeD ", "mixed"], [null, null] ];

export const cases = {
  discovery: { station: "plan", mode: "discovery" },
  "spec-specialists": { station: "spec", mode: "specialists" },
  "test-plan-specialists": { station: "test-plan", mode: "specialists" },
  "verify-specialists": { station: "verify", mode: "specialists" },
  "unit-proposals": { station: "unit-tests", mode: "proposals" },
  "implementation-proposals": { station: "implementation", mode: "proposals" },
  "unit-checks": { station: "unit-tests", mode: "checks" },
  "implementation-checks": { station: "implementation", mode: "checks" },
  "verify-checks": { station: "verify", mode: "checks" },
} as const satisfies Record<string, { station: Station; mode: string }>;
export type CaseId = keyof typeof cases;

const documents: Partial<Record<Station, string>> = {
  intent: `# Normalize notifications
## What the product can't do today
Blank or null email and SMS text produces an empty notification.
## Who is affected
Existing email and SMS callers.
## What better looks like
Both packages return null for blank or null text and preserve lowercase trimmed text for everything else.
## Out of scope
Delivery and changes to the normalize API.
## Constraints
No dependencies. Keep the packages independent.
`,
  spec: `# Normalize notifications
## Summary
Both packages use normalize(value) to normalize text.
## Requirements and acceptance criteria
| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| AC-1 | Email normalization | Given blank or null email text, return null. For nonblank strings, trim and lowercase. |
| AC-2 | SMS normalization | Given blank or null SMS text, return null. For nonblank strings, trim and lowercase. |
## Roles and permissions
Existing callers can use each pure function. No permissions change.
## Business rules and edge cases
The empty string, spaces, tabs, and newlines are blank. Mixed case nonblank strings are preserved after trimming and lowercasing.
## Non-goals
No changes to delivery or dependencies.
`,
  plan: `# Normalize notifications
## Description
Update both packages independently and preserve their existing exports.
## Files to change
${scope.join(", ")}
## Steps to implement
Write one case table per package, then implement each normalize function.
## Test plan
See test-plan.md for the pinned RED and final GREEN checks.
## Risks
Keep behavior for mixed case nonblank text and catch null and whitespace edge cases.
`,
  "test-plan": `# Normalization checks
## Acceptance coverage
AC-1 covers email and AC-2 covers SMS with separate unit profiles.
## Unit tests
Use ${testFiles.join(" and ")} with counted behavior checks.
## Regression
Keep trimming and lowercasing nonblank strings in both packages.
## Required evidence
The required checks must produce assertion RED on the pinned baseline and GREEN on the candidate.
`,
};

// Generated test proposals are inert JSON tables. Generated implementation is
// evaluated without host globals, module loading, or injected host functions.
const runner = `import { readFileSync } from "node:fs";
import { strictEqual } from "node:assert";
import { createContext, Script } from "node:vm";
function evaluate(file, input) {
  const source = readFileSync(file, "utf8");
  if (!/^\\s*export\\s+function\\s+normalize\\s*\\(/m.test(source)) throw new Error("Expected named normalize export");
  const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  return new Script('"use strict";\\n' + source.replace(/\\bexport\\s+function\\s+normalize\\b/, "function normalize") +
    "\\nnormalize(" + JSON.stringify(input) + ")").runInContext(context, { timeout: 250 });
}
if (process.argv[2] === "--oracle") {
  let json = "";
  for await (const chunk of process.stdin) json += chunk;
  const checks = JSON.parse(json).map(({file, input, expected}) => {
    try { strictEqual(evaluate(file, input), expected); return true; } catch { return false; }
  });
  console.log(JSON.stringify(checks));
} else {
  const file = process.argv[2];
  const source = readFileSync(file, "utf8").trim();
  const match = /^export default (\\[[\\s\\S]*\\]);?$/.exec(source);
  if (!match) throw new Error("Expected a JSON array after export default");
  const cases = JSON.parse(match[1]);
  if (!cases.length || cases.length > 20 || cases.some(row => !Array.isArray(row) || row.length !== 2 || row.some(v => v !== null && typeof v !== "string")))
    throw new Error("Expected one to twenty [input, expected] string or null pairs");
  const ac = file.replaceAll("\\\\", "/").includes("/email/") ? "AC-1" : "AC-2";
  const assertionResults = cases.map(([input, expected], index) => {
    const fullName = ac + " normalization case " + (index + 1);
    try { strictEqual(evaluate(file.replace(/\\.test\\.mjs$/, ".mjs"), input), expected); return {fullName, status:"passed"}; }
    catch (error) { return {fullName, status:"failed", failureMessages:[String(error.stack ?? error)]}; }
  });
  const failed = assertionResults.filter(test => test.status === "failed").length;
  console.log(JSON.stringify({numTotalTests:cases.length,numPassedTests:cases.length-failed,numFailedTests:failed,testResults:[{assertionResults}]}));
  process.exitCode = failed ? 1 : 0;
}
`;

export async function createQualificationFixture(root: string) {
  const write = (file: string, value: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  write(".gitignore", ".kitchen/\nkitchen.config.json\n");
  write("AGENTS.md", `Disposable notification fixture. Implement the exact request in ${modules.join(" and ")}.
Each file exports a named function with the syntax export function normalize(value). Use plain JavaScript and no imports in the production modules.
The only unit test files are ${testFiles.join(" and ")}. Each is a data-only case table using export default followed by a strict JSON array of [input, expected] pairs and an optional semicolon. Use string or null values. check.mjs runs real assertions. No dependencies or scaffolds.
Use the email-unit profile for the email file and sms-unit for the SMS file. Acceptance IDs are AC-1 for email and AC-2 for SMS. The approved plan scope is limited to these four files. Report verification defects in summary and reserve questions for unresolved operator decisions.
`);
  write("check.mjs", runner);
  for (const file of modules)
    write(file, 'export function normalize(value) { return typeof value === "string" ? value.trim().toLowerCase() : ""; }\n');
  await git(root, "init", "--quiet", "--initial-branch=main");
  await git(root, "config", "user.name", "Kitchen Qualification Fixture");
  await git(root, "config", "user.email", "kitchen-qualification@example.invalid");
  await git(root, "config", "core.autocrlf", "false");
  await git(root, "add", ".");
  await git(root, "-c", "core.hooksPath=", "commit", "--quiet", "-m", "Pinned notification fixture");
  return git(root, "rev-parse", "HEAD");
}

export function fixtureConfig(id: CaseId, candidate: boolean, author: RoleConfig, timeoutMs: number): Config {
  const { station, mode } = cases[id];
  const profiles: Config["profiles"] = {};
  for (const name of packages) profiles[`${name}-unit`] = {
    kind: "unit", cwd: `packages/${name}`, command: process.execPath,
    args: ["--permission", "--allow-fs-read=../..", "../../check.mjs", "{files}"],
    parser: "vitest-json", timeoutMs: 5000,
    ...(mode === "checks" && candidate ? { parallelSafe: true } : {}),
  };
  const stations: Config["stations"] = { [station]: { author } };
  if (candidate && mode === "specialists") stations[station]!.specialistsEnabled = true;
  if (candidate && mode === "proposals") {
    const paths = station === "unit-tests" ? testFiles : modules;
    stations[station]!.proposalGroups = { [feature]: [[paths[0]!], [paths[1]!]] };
  }
  return {
    version: 1, base: "main", github: { repository: "" },
    providers: { author: { provider: "codex" }, review: { provider: "codex" }, timeoutMs },
    profiles, stations,
    ...(candidate && mode === "discovery" ? { discovery: { enabled: true, author } } : {}),
  };
}

export const fixtureProvider = (target: Station): Provider => async req => {
  const output: AuthorOutput = {
    summary: req.station === "verify"
      ? 'SMS normalize(null) returns an empty string instead of null in packages/sms/normalize.mjs.'
      : "Pinned fixture artifact",
    document: documents[req.station] ?? null,
    questions: [], files: [], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [],
  };
  if (req.station === "plan") output.allowedPaths = scope;
  if (req.station === "test-plan") {
    output.unitTestFiles = testFiles;
    output.checks = packages.map((name, index) => ({ id: `${name}-normalization`, profile: `${name}-unit`,
      files: [testFiles[index]!], acIds: [`AC-${index + 1}`], required: true, expectation: "red" }));
  }
  if (req.station === "unit-tests") output.files = testFiles.map(file => ({ path: file, action: "write", kind: "test",
    content: `export default ${JSON.stringify(target === "verify" ? pinnedTests.slice(0, 2) : pinnedTests)};\n` }));
  if (req.station === "implementation") output.files = modules.map((file, index) => ({ path: file, action: "write", kind: "implementation",
    content: target === "verify" && index === 1 ? seededDefect : normalize }));
  if (req.kind === "discovery" || req.kind === "specialist")
    return { summary: "Fixture analysis", evidence: [{ path: modules[0]!, line: 1, hash: "" }], unresolved: [] };
  if (req.kind === "proposal") {
    const index = path.basename(req.runDir) === "group-1" ? 0 : 1;
    return { summary: output.summary, questions: [], files: [output.files[index]!] };
  }
  return output;
};

const sameSet = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length && expected.every(value => actual.includes(value));

function coversTestCases(content: string) {
  try {
    const body = /^export default (\[[\s\S]*\]);?$/.exec(content.trim())?.[1];
    const cases: Array<[string | null, string | null]> = JSON.parse(body ?? "null");
    return cases.some(([input, expected]) => typeof input === "string" && input.length > 0 && !input.trim() && expected === null) &&
      cases.some(([input, expected]) => input === null && expected === null) &&
      cases.some(([input, expected]) => typeof input === "string" && input.trim() && input !== input.trim().toLowerCase() && expected === input.trim().toLowerCase());
  } catch { return false; }
}

export async function scoreFixture(station: Station, record: StationRecord | undefined, worktree: string, signal?: AbortSignal) {
  const score: Record<string, boolean> = { runnerGate: record?.status === "awaiting-approval" && gateReady(record.findings, record.checks, {}) };
  const output = record?.output;
  if (!output) return score;
  if (station === "spec") {
    const doc = output.document ?? "";
    score.observableCriteria = acceptanceIds(doc).length >= 2;
    score.bothPackages = /\bemail\b/i.test(doc) && /\bsms\b/i.test(doc);
    score.contractTerms = /\bnull\b/i.test(doc) && /blank|whitespace/i.test(doc) && /trim/i.test(doc) && /lowercase|lower case/i.test(doc);
  } else if (station === "plan") {
    score.exactScope = sameSet(output.allowedPaths, scope);
  } else if (station === "test-plan") {
    score.exactUnitScope = sameSet(output.unitTestFiles, testFiles) && output.scaffoldFiles.length === 0;
    score.requiredRedMapping = packages.every((name, index) => output.checks.some(check => check.required && check.expectation === "red" &&
      check.profile === `${name}-unit` && sameSet(check.files, [testFiles[index]!]) && check.acIds.includes(`AC-${index + 1}`)));
  } else if (station === "unit-tests") {
    score.pinnedAssertionRed = record!.checks.length === 2 && record!.checks.every(check => check.status === "expected-red");
    score.coversNullWhitespaceAndPreservation = testFiles.every(file => {
      try { return coversTestCases(readFileSync(path.join(worktree, file), "utf8")); } catch { return false; }
    });
  } else if (station === "implementation") {
    score.integratedGreen = record!.checks.length === 2 && record!.checks.every(check => check.status === "passed");
    const input = JSON.stringify(modules.flatMap(file => [
      { file, input: "\n \t ", expected: null }, { file, input: "", expected: null },
      { file, input: null, expected: null }, { file, input: "  QuALiFy  Here \t", expected: "qualify  here" },
    ]));
    const result = await runProcess({ command: process.execPath, args: ["--permission", "--allow-fs-read=.", "check.mjs", "--oracle"],
      cwd: worktree, input, timeoutMs: 5000, signal });
    try {
      const values: unknown = JSON.parse(result.stdout);
      score.independentBehaviorOracle = result.code === 0 && Array.isArray(values) && values.length === 8 && values.every(v => v === true);
    } catch { score.independentBehaviorOracle = false; }
  } else if (station === "verify") {
    score.freshGreen = record!.checks.length === 2 && record!.checks.every(check => check.status === "passed");
    score.seededDefectMentioned = /\bsms\b/i.test(output.summary) && /\bnull\b/i.test(output.summary) && /empty string|""|''/i.test(output.summary);
  }
  return score;
}
