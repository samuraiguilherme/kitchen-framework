import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { executeChecks } from "../src/checks.ts";
import { loadConfig } from "../src/config.ts";
import { buildContext } from "../src/context.ts";
import { discover, preparePlanContext } from "../src/discovery.ts";
import { hash } from "../src/domain.ts";
import { evidenceBundle } from "../src/evidence-bundle.ts";
import { runFileProposals } from "../src/file-proposals.ts";
import { git, sourceSnapshot, type SourceSnapshot } from "../src/git.ts";
import { runSpecialists } from "../src/specialists.ts";
import type { CheckDefinition, DiscoveryResult, FeatureState, FileProposal, Profile, ProposalGroups, ProposalStation, Provider, ProviderRequest, SpecialistStation } from "../src/types.ts";

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
const ids = ["suite-one", "one", "three", "four"];
for (const id of ids) mkdirSync(path.join(fixture, id));
const checkModes = ["serial", "independent", "shared-resource", "shared-cwd", "exclusive-barrier"];
const definitions: CheckDefinition[] = ids.map(id => ({ id, profile: id, files: [], acIds: [], required: true, expectation: "green" }));
const checkCode = "const id=process.argv[1];const start=Date.now();setTimeout(()=>console.log(JSON.stringify({id,start,end:Date.now()})),180);";
for (let iteration = 0; iteration < iterations; iteration++) {
  const modes = [...checkModes];
  if (iteration % 2) modes.reverse();
  for (const mode of modes) {
    const profiles: Record<string, Profile> = Object.fromEntries(ids.map(id => [id, {
      kind: "command", command: process.execPath, args: ["-e", checkCode, id], parser: "exit-code", timeoutMs: 10000,
      parallelSafe: mode !== "serial" && !(mode === "exclusive-barrier" && id === "three"),
      cwd: mode === "shared-cwd" ? "." : id,
      resourceGroup: mode === "shared-resource" ? "shared" : mode === "shared-cwd" ? id : undefined,
    }]));
    const runDir = path.join(fixture, ".kitchen/runs", `checks-${mode}-${iteration}`);
    const measured = await measure(() => executeChecks({
      definitions, profiles, root: fixture, runDir, fingerprint: "fixture", green: true,
    }));
    assert.deepEqual(measured.result.map(item => item.id), ids);
    assert(measured.result.every(item => item.status === "passed"));
    for (const result of measured.result) {
      const files = ["check", "raw"].map(kind => path.join(runDir, `${kind}-${result.id}.json`));
      assert.deepEqual(result.evidenceHashes, Object.fromEntries(files.map(file => [file, hash(readFileSync(file))])));
    }
    const spans = ids.map(id => {
      const raw = JSON.parse(readFileSync(path.join(runDir, `raw-${id}.json`), "utf8"));
      return JSON.parse(raw.stdout) as { id: string; start: number; end: number };
    });
    const events = spans.flatMap(span => [{ time: span.start, delta: 1 }, { time: span.end, delta: -1 }])
      .sort((a, b) => a.time - b.time || a.delta - b.delta);
    let active = 0, maximum = 0;
    for (const event of events) { active += event.delta; maximum = Math.max(maximum, active); }
    assert.equal(maximum, ["serial", "shared-resource", "shared-cwd"].includes(mode) ? 1 : 2);
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
  summaries: Object.fromEntries(checkModes.map(mode =>
    [mode, summarize(checkSamples.filter(x => x.mode === mode).map(x => x.ms as number))])),
};
assertions.push("Real Node check processes: independent package profiles use two slots; shared groups and working directories serialize even with opt-in; exclusive barriers, manifest order, and exact artifact ownership are preserved.");

// H3: compare the runner's plan preparation with the previous sequential order.
config.providers.author = { provider: "codex" };
const contextSamples: Record<string, unknown>[] = [];
for (let iteration = 0; iteration < iterations; iteration++) {
  const paired: Array<Awaited<ReturnType<typeof preparePlanContext>>> = [];
  for (const mode of iteration % 2 ? ["overlap", "sequential"] : ["sequential", "overlap"]) {
    const before = await sourceSnapshot(fixture, state.feature);
    const configRoot = path.join(directory, `context-${mode}-${iteration}`);
    let calls = 0;
    const provider: Provider = async request => { calls++; await delay(110); return output(request); };
    const options = { root: configRoot, state, config, provider, runDir: path.join(configRoot, "run") };
    const build = () => buildContext(state, "plan", configRoot, false, { codeFingerprint: before.codeFingerprint, persist: true });
    const measured = await measure(async () => {
      if (mode === "overlap") return preparePlanContext({ ...options, before }, build);
      const context = await build();
      const results = await discover({ ...options, codeFingerprint: before.codeFingerprint });
      assert.equal((await sourceSnapshot(fixture, state.feature)).fingerprint, before.fingerprint);
      return { context, results };
    });
    assert.equal(calls, 2);
    assert(measured.result.context.includes("src/answer.ts"));
    assert.deepEqual(measured.result.results.map(item => item.summary), ["implementation", "verification"]);
    paired.push(measured.result);
    contextSamples.push({ iteration, mode, ms: measured.ms, contextBytes: Buffer.byteLength(measured.result.context) });
  }
  assert.deepEqual(paired[0], paired[1]);
}
report.contextOverlap = {
  samples: contextSamples,
  sequential: summarize(contextSamples.filter(x => x.mode === "sequential").map(x => x.ms as number)),
  overlap: summarize(contextSamples.filter(x => x.mode === "overlap").map(x => x.ms as number)),
};
assertions.push("Production plan preparation, including the post-discovery source guard: overlap produces identical context and ordered discovery results with the same provider call count as sequential preparation.");

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

// H5: exercise the production specialist batch with source validation and evidence writes.
const specialistStations: SpecialistStation[] = ["spec", "test-plan", "verify"];
const specialistSamples: Array<{ station: SpecialistStation; iteration: number; mode: string; ms: number; maximum: number; calls: number }> = [];
for (const station of specialistStations) {
  for (let iteration = 0; iteration < iterations; iteration++) {
    const before = await sourceSnapshot(fixture, state.feature);
    const paired: Array<Awaited<ReturnType<typeof runSpecialists>>> = [];
    for (const mode of iteration % 2 ? ["parallel", "serial"] : ["serial", "parallel"]) {
      config.stations[station] = { specialistsEnabled: true, author: { provider: mode === "serial" ? "deepseek" : "codex" } };
      let active = 0, maximum = 0, calls = 0;
      const provider: Provider = async request => {
        assert.equal(request.station, station);
        assert.equal(request.kind, "specialist");
        maximum = Math.max(maximum, ++active);
        await delay(calls++ === 0 ? 70 : 110);
        active--;
        return {
          summary: path.basename(request.runDir),
          evidence: [{ path: "src/answer.ts", line: 1, hash: "" }],
          unresolved: [],
        };
      };
      const runDir = path.join(directory, `specialists-${station}-${mode}-${iteration}`);
      const measured = await measure(() => runSpecialists({ station, state, config, before, provider, runDir }));
      assert.equal(calls, 2);
      assert.equal(maximum, mode === "serial" ? 1 : 2);
      for (const result of measured.result) {
        assert.equal(result.evidence[0]?.hash, hash(readFileSync(path.join(fixture, "src/answer.ts"))));
        assert.deepEqual(JSON.parse(readFileSync(path.join(runDir, result.taskId, "validated-output.json"), "utf8")), result);
      }
      paired.push(measured.result);
      specialistSamples.push({ station, iteration, mode, ms: measured.ms, maximum, calls });
    }
    assert.deepEqual(paired[0], paired[1]);
  }
}
report.specialists = {
  samples: specialistSamples,
  summaries: Object.fromEntries(specialistStations.map(station => [station,
    Object.fromEntries(["serial", "parallel"].map(mode => [mode, summarize(specialistSamples
      .filter(sample => sample.station === station && sample.mode === mode).map(sample => sample.ms))])),
  ])),
};
assertions.push("Specialist batches at spec, test-plan, and verify produce the same ordered, source-verified evidence with two calls, using one local slot or two hosted slots. Timing includes source validation and excludes authoring and approvals.");

// H6: measure proposal generation and the guarded join before candidate application.
const proposalGroups: Record<ProposalStation, ProposalGroups> = {
  "unit-tests": [["src/answer.test.ts", "src/preservation.test.ts"], ["src/bonus.test.ts"]],
  implementation: [["src/answer.ts", "src/interface.ts"], ["src/bonus.ts"]],
};
const proposalStations = ["unit-tests", "implementation"] as const;
const proposalSamples: Array<{ station: ProposalStation; iteration: number; mode: string; ms: number; maximum: number; calls: number }> = [];
for (const station of proposalStations) {
  const groups = proposalGroups[station];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const before = await sourceSnapshot(fixture, state.feature);
    const paired: Array<Awaited<ReturnType<typeof runFileProposals>>> = [];
    for (const mode of iteration % 2 ? ["parallel", "serial"] : ["serial", "parallel"]) {
      let active = 0, maximum = 0, calls = 0;
      const provider: Provider = async (request): Promise<FileProposal> => {
        assert.equal(request.station, station);
        assert.equal(request.kind, "proposal");
        const index = path.basename(request.runDir) === "group-1" ? 0 : 1;
        calls++;
        maximum = Math.max(maximum, ++active);
        await delay(index === 0 ? 110 : 70);
        active--;
        return { summary: `Group ${index + 1}`, questions: [], files: [...groups[index]].reverse().map(file => ({
          path: file, action: "write", content: `// Proposal for ${file}\n`, kind: station === "unit-tests" ? "test" : "implementation",
        })) };
      };
      const runDir = path.join(directory, `proposals-${station}-${mode}-${iteration}`);
      const measured = await measure(() => runFileProposals({
        station, worktree: fixture, feature: state.feature, groups, eligible: groups.flat(),
        protectedPaths: station === "implementation" ? ["src/answer.test.ts"] : [],
        source: before.fingerprint, prompt: "Draft your assigned files.", provider, runDir,
        config: { provider: mode === "serial" ? "deepseek" : "codex" }, timeoutMs: 10000,
      }));
      assert.equal(calls, 2);
      assert.equal(maximum, mode === "serial" ? 1 : 2);
      assert.deepEqual(measured.result.files.map(file => file.path), groups.flat());
      assert.deepEqual(JSON.parse(readFileSync(path.join(runDir, "validated-output.json"), "utf8")), measured.result);
      paired.push(measured.result);
      proposalSamples.push({ station, iteration, mode, ms: measured.ms, maximum, calls });
    }
    assert.deepEqual(paired[0], paired[1]);
  }
}
report.proposals = {
  samples: proposalSamples,
  summaries: Object.fromEntries(proposalStations.map(station => [station,
    Object.fromEntries(["serial", "parallel"].map(mode => [mode, summarize(proposalSamples
      .filter(sample => sample.station === station && sample.mode === mode).map(sample => sample.ms))])),
  ])),
};
assertions.push("File proposal batches produce the same ownership-ordered joined candidate with one local slot or two hosted slots. Timing covers proposal generation and validation, before applying files, checks, or approval.");

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
