import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { executeChecks } from "../src/checks.ts";
import { loadConfig } from "../src/config.ts";
import { buildContext } from "../src/context.ts";
import { discover } from "../src/discovery.ts";
import { hash } from "../src/domain.ts";
import { evidenceBundle } from "../src/evidence-bundle.ts";
import { git, sourceSnapshot, type SourceSnapshot } from "../src/git.ts";
import type { CheckDefinition, DiscoveryResult, FeatureState, Profile, Provider, ProviderRequest } from "../src/types.ts";

// Offline experiments against production functions. Provider latency is synthetic;
// checks spawn real Node processes. No provider CLI, install, push or PR is used.
const { values } = parseArgs({ options: {
  iterations: { type: "string", default: "5" },
} });
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 20);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".kitchen/benchmarks", `station-optimization-${randomUUID()}`);
const fixture = path.join(directory, "fixture");
const write = (file: string, content: string) => {
  const absolute = path.join(fixture, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
};
write(".gitignore", ".kitchen/\n");
write("package.json", '{"name":"station-benchmark","private":true}\n');
write("AGENTS.md", "Use the existing answer module.\n");
write("src/answer.ts", "export const answer = () => 42;\n");
write("src/answer.test.ts", "// AC-1: answer is 42\n");
write("docs/features/demo/spec.md", "Inspect src/answer.ts and src/answer.test.ts\n");
await git(fixture, "init", "--quiet");
await git(fixture, "add", ".");
await git(fixture, "-c", "user.name=Kitchen Benchmark", "-c", "user.email=benchmark@example.invalid", "-c", "core.hooksPath=", "commit", "--quiet", "-m", "benchmark fixture");
const baseCommit = await git(fixture, "rev-parse", "HEAD");
const config = loadConfig(fixture);
const state: FeatureState = {
  version: 1, feature: "demo", request: "Inspect src/answer.ts and src/answer.test.ts",
  worktree: fixture, branch: "fixture", baseCommit, conversation: [],
  stations: { spec: {
    status: "approved", runId: "spec", rubricVersion: "1", profileVersions: {},
    findings: [], checks: [], summary: "fixture spec", artifactFiles: ["docs/features/demo/spec.md"],
    approval: { actor: "fixture", at: new Date(0).toISOString(), fingerprint: "spec-v1", resolutions: {} },
  } },
};
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const measure = async <T>(action: () => Promise<T>) => {
  const start = performance.now();
  const result = await action();
  return { ms: performance.now() - start, result };
};
const median = (numbers: number[]) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]!;
const summarize = (numbers: number[]) => ({ medianMs: median(numbers), minMs: Math.min(...numbers), maxMs: Math.max(...numbers) });
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  iterations, directory, sourceCommit: await git(root, "rev-parse", "HEAD"),
  sourceStatus: await git(root, "status", "--short"),
  limits: "Synthetic provider delays (70/110 ms), real child-process checks (180 ms each), synthetic small Git fixture. These are scheduling experiments, not model-quality or production speedup measurements.",
};
const assertions: string[] = [];
const output = (request: ProviderRequest): DiscoveryResult => ({
  summary: request.prompt.includes("(implementation)") ? "implementation" : "verification",
  evidence: [{ path: request.prompt.includes("(implementation)") ? "src/answer.ts" : "src/answer.test.ts", line: 1, hash: "" }],
  unresolved: [],
});
const discoveryOptions = (provider: Provider, key: string) => ({
  root: fixture, state, config, provider, codeFingerprint: key,
  runDir: path.join(fixture, ".kitchen/runs", key),
});

// H1: paired independent discovery overlaps and reports ordered, verified results.
const discoverySamples: Record<string, unknown>[] = [];
for (let iteration = 0; iteration < iterations; iteration++) {
  for (const mode of iteration % 2 ? ["parallel", "serial"] : ["serial", "parallel"]) {
    config.providers.author = { provider: mode === "serial" ? "deepseek" : "codex" };
    let active = 0, maximum = 0, calls = 0;
    const provider: Provider = async request => {
      calls++; active++; maximum = Math.max(maximum, active);
      await delay(request.prompt.includes("(implementation)") ? 70 : 110);
      active--;
      return output(request);
    };
    const options = discoveryOptions(provider, `discovery-${mode}-${iteration}`);
    const before = await sourceSnapshot(fixture, state.feature);
    const cold = await measure(() => discover(options));
    assert.equal(calls, 2);
    assert.equal(maximum, mode === "serial" ? 1 : 2);
    assert.deepEqual(cold.result.map(item => item.summary), ["implementation", "verification"]);
    for (const result of cold.result)
      for (const citation of result.evidence)
        assert.equal(citation.hash, hash(readFileSync(path.join(fixture, citation.path))));
    const warm = await measure(() => discover(options));
    assert.equal(calls, 2);
    assert.deepEqual(warm.result, cold.result);
    assert.equal((await sourceSnapshot(fixture, state.feature)).fingerprint, before.fingerprint);
    discoverySamples.push({ iteration, mode, coldMs: cold.ms, warmMs: warm.ms, maximum, calls });
  }
}
report.discovery = {
  samples: discoverySamples,
  serial: summarize(discoverySamples.filter(x => x.mode === "serial").map(x => x.coldMs as number)),
  parallel: summarize(discoverySamples.filter(x => x.mode === "parallel").map(x => x.coldMs as number)),
  warm: summarize(discoverySamples.map(x => x.warmMs as number)),
};
assertions.push("Discovery: hosted=2 simultaneous workers, local policy=1; declared result order, source hashes, no source mutation, and zero additional provider calls on valid cache hits.");

// H2: independent command checks overlap; resource conflicts and barriers serialize.
const checkSamples: Record<string, unknown>[] = [];
const ids = ["one", "two", "three", "four"];
const definitions: CheckDefinition[] = ids.map(id => ({ id, profile: id, files: [], acIds: [], required: true, expectation: "green" }));
const checkCode = "const id=process.argv[1];const start=Date.now();setTimeout(()=>console.log(JSON.stringify({id,start,end:Date.now()})),180);";
for (let iteration = 0; iteration < iterations; iteration++) {
  const modes = ["serial", "independent", "shared-resource", "exclusive-barrier"];
  if (iteration % 2) modes.reverse();
  for (const mode of modes) {
    const profiles: Record<string, Profile> = Object.fromEntries(ids.map(id => [id, {
      kind: "command", command: process.execPath, args: ["-e", checkCode, id], parser: "exit-code", timeoutMs: 10000,
      parallelSafe: mode !== "serial" && !(mode === "exclusive-barrier" && id === "three"),
      resourceGroup: mode === "shared-resource" ? "shared" : id,
    }]));
    const runDir = path.join(fixture, ".kitchen/runs", `checks-${mode}-${iteration}`);
    const measured = await measure(() => executeChecks({
      definitions, profiles, root: fixture, runDir, fingerprint: "fixture", green: true,
    }));
    assert.deepEqual(measured.result.map(item => item.id), ids);
    assert(measured.result.every(item => item.status === "passed"));
    const spans = ids.map(id => {
      const raw = JSON.parse(readFileSync(path.join(runDir, `raw-${id}.json`), "utf8"));
      return JSON.parse(raw.stdout) as { id: string; start: number; end: number };
    });
    const events = spans.flatMap(span => [{ time: span.start, delta: 1 }, { time: span.end, delta: -1 }])
      .sort((a, b) => a.time - b.time || a.delta - b.delta);
    let active = 0, maximum = 0;
    for (const event of events) { active += event.delta; maximum = Math.max(maximum, active); }
    assert.equal(maximum, ["serial", "shared-resource"].includes(mode) ? 1 : 2);
    if (mode === "exclusive-barrier") {
      const barrier = spans[2]!;
      assert(spans.slice(0, 2).every(span => span.end <= barrier.start));
      assert(barrier.end <= spans[3]!.start);
    }
    checkSamples.push({ iteration, mode, ms: measured.ms, maximum, spans });
  }
}
report.checks = {
  samples: checkSamples,
  summaries: Object.fromEntries(["serial", "independent", "shared-resource", "exclusive-barrier"].map(mode =>
    [mode, summarize(checkSamples.filter(x => x.mode === mode).map(x => x.ms as number))])),
};
assertions.push("Real Node check processes: independent profiles use exactly two slots; shared resources serialize; exclusive barrier waits for earlier checks and blocks later checks; all four statuses and result order are preserved.");

// H3: context and read-only discovery can join before the author on one snapshot.
config.providers.author = { provider: "codex" };
const contextSamples: Record<string, unknown>[] = [];
for (let iteration = 0; iteration < iterations; iteration++) {
  for (const mode of iteration % 2 ? ["overlap", "sequential"] : ["sequential", "overlap"]) {
    const before = await sourceSnapshot(fixture, state.feature);
    const key = `context-${mode}-${iteration}`;
    const provider: Provider = async request => { await delay(110); return output(request); };
    const context = () => buildContext(state, "plan", fixture, false, { codeFingerprint: before.codeFingerprint, persist: true });
    const discovery = () => discover(discoveryOptions(provider, key));
    const measured = await measure(async () => {
      if (mode === "overlap") return Promise.all([context(), discovery()] as const);
      return [await context(), await discovery()] as const;
    });
    assert(measured.result[0].includes("src/answer.ts"));
    assert.deepEqual(measured.result[1].map(item => item.summary), ["implementation", "verification"]);
    assert.equal((await sourceSnapshot(fixture, state.feature)).fingerprint, before.fingerprint);
    const reference = await context();
    assert.equal(measured.result[0], reference);
    contextSamples.push({ iteration, mode, ms: measured.ms, contextBytes: Buffer.byteLength(reference) });
  }
}
report.contextOverlap = {
  samples: contextSamples,
  sequential: summarize(contextSamples.filter(x => x.mode === "sequential").map(x => x.ms as number)),
  overlap: summarize(contextSamples.filter(x => x.mode === "overlap").map(x => x.ms as number)),
};
assertions.push("Prototype composition of production functions: context plus discovery can overlap; context text, ordered child results and source identity remain unchanged before author handoff.");

// H4: current evidence cache preserves correctness but still rebuilds on a hit.
const bundleSamples: Record<string, unknown>[] = [];
for (let iteration = 0; iteration < iterations; iteration++) {
  const key = `bundle-${iteration}`;
  const cold = await measure(() => evidenceBundle(state, "plan", fixture, { codeFingerprint: key, persist: true }));
  const warm = await measure(() => evidenceBundle(state, "plan", fixture, { codeFingerprint: key, persist: true }));
  assert.equal(cold.result.cacheHit, false);
  assert.equal(warm.result.cacheHit, true);
  assert.equal(cold.result.text, warm.result.text);
  bundleSamples.push({ iteration, coldMs: cold.ms, warmMs: warm.ms });
}
const cached = await evidenceBundle(state, "plan", fixture, { codeFingerprint: "invalidation", persist: true });
write("src/answer.ts", "export const answer = () => 43;\n");
const invalidated = await evidenceBundle(state, "plan", fixture, { codeFingerprint: "invalidation", persist: true });
assert.equal(invalidated.cacheHit, false);
assert.notEqual(invalidated.key, cached.key);
assert(invalidated.text.includes("43"));
report.evidenceCache = { samples: bundleSamples,
  cold: summarize(bundleSamples.map(x => x.coldMs as number)),
  warm: summarize(bundleSamples.map(x => x.warmMs as number)),
};
assertions.push("Evidence cache hits return identical text and a selected source edit invalidates the cache even with the same supplied code key.");

// Real checkout scan cost is measured separately from the tiny scheduling fixture.
const snapshotSamples: Array<SourceSnapshot & { iteration: number; ms: number }> = [];
for (let iteration = 0; iteration < iterations; iteration++) {
  const measured = await measure(() => sourceSnapshot(root, "station-optimization-benchmark"));
  snapshotSamples.push({ iteration, ms: measured.ms, ...measured.result });
}
assert(snapshotSamples.every(sample => sample.fingerprint === snapshotSamples[0]!.fingerprint));
report.checkoutSnapshots = { samples: snapshotSamples, ...summarize(snapshotSamples.map(x => x.ms)) };
report.assertions = assertions;
report.completedAt = new Date().toISOString();
const reportFile = path.join(directory, "report.json");
writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ reportFile, iterations, assertions }, null, 2));
