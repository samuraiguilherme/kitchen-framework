import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { replaceFileSync } from "../src/atomic-file.ts";
import { sourceFiles, sourceFingerprint } from "../src/git.ts";
import { safePath, stationOrder } from "../src/domain.ts";
import { Kitchen } from "../src/kitchen.ts";
import { cliProvider } from "../src/providers.ts";
import { Storage } from "../src/storage.ts";
import { intervalUnion } from "../src/timings.ts";
import type { ProviderMetrics, ProviderRequest, RoleConfig, RunMetrics, StationRecord } from "../src/types.ts";
import { cases, createQualificationFixture, feature, fixtureConfig, fixtureProvider, request, scoreFixture, type CaseId } from "./lib/station-qualification-fixture.ts";
import { codexQuota } from "./lib/codex-quota.ts";

type Arm = "baseline" | "opt-in";
interface Call {
  role: ProviderRequest["role"];
  kind: ProviderRequest["kind"] | "author";
  evidence: string;
  status: "running" | "completed" | "failed";
  error?: string;
  attempts: ProviderMetrics[];
}
interface Sample {
  case: CaseId;
  iteration: number;
  arm: Arm;
  root: string;
  status: string;
  source?: string;
  testsFirstCommit?: string;
  runId?: string;
  activeMs?: number;
  humanWaitMs?: number;
  phases?: RunMetrics["phases"];
  fixedFeedback?: string;
  error?: string;
  findings?: StationRecord["findings"];
  checks?: StationRecord["checks"];
  quality: Record<string, boolean>;
  calls: Call[];
}

function number(value: string, name: string, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function total(values: Array<number | undefined>): number | null {
  if (!values.length || values.some(value => value === undefined || !Number.isFinite(value) || value < 0)) return null;
  return values.reduce<number>((sum, value) => sum + value!, 0);
}

function tokens(attempt: ProviderMetrics): number | undefined {
  if (attempt.tokens) return attempt.tokens.usageComplete ? attempt.tokens.totalTokens : undefined;
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = attempt.usage ?? {};
  if (input_tokens === undefined || output_tokens === undefined) return;
  // Codex input_tokens already contains the cached subset. Claude reports its
  // uncached input and cache buckets separately. Output already includes reasoning.
  return input_tokens + output_tokens + (attempt.provider === "claude"
    ? (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0) : 0);
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!, count: sorted.length };
}

function summarizeArm(samples: Sample[]) {
  const calls = samples.flatMap(sample => sample.calls);
  const attempts = calls.flatMap(call => call.attempts);
  const complete = calls.every(call => call.status !== "running" && call.attempts.length > 0);
  return {
    samples: samples.length,
    ready: samples.filter(sample => sample.status === "awaiting-approval").length,
    qualityPassed: samples.filter(qualityPassed).length,
    failures: samples.filter(sample => sample.status === "failed" || sample.status === "setup-failed").length,
    awaitingInput: samples.filter(sample => sample.status === "awaiting-input").length,
    allActiveMs: stats(samples.flatMap(sample => sample.activeMs === undefined ? [] : [sample.activeMs])),
    calls: calls.length, attempts: attempts.length,
    failedCalls: calls.filter(call => call.status === "failed").length,
    retries: calls.reduce((count, call) => count + Math.max(0, call.attempts.length - 1), 0),
    totalTokens: complete ? total(attempts.map(tokens)) : null,
    knownTokens: attempts.reduce((sum, attempt) => sum + (tokens(attempt) ?? attempt.tokens?.knownTotalTokens ?? 0), 0),
    reportedCostUsd: complete ? total(attempts.map(attempt => attempt.reportedCostUsd)) : null,
    providerWorkMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
    providerElapsedMs: intervalUnion(attempts.flatMap(attempt => {
      const start = Date.parse(attempt.startedAt ?? "");
      return Number.isFinite(start) ? [[start, start + attempt.durationMs] as [number, number]] : [];
    })),
  };
}

const qualityPassed = (sample: Sample) => Object.values(sample.quality).length > 0 && Object.values(sample.quality).every(Boolean);
const change = (baseline: number | null | undefined, candidate: number | null | undefined) =>
  baseline != null && baseline > 0 && candidate != null ? 100 * (candidate / baseline - 1) : null;

function compare(samples: Sample[], ids: CaseId[], iterations: number, live: boolean, toolsEnabled: boolean) {
  return Object.fromEntries(ids.map(id => {
    const baselineSamples = samples.filter(sample => sample.case === id && sample.arm === "baseline");
    const optInSamples = samples.filter(sample => sample.case === id && sample.arm === "opt-in");
    const matched = baselineSamples.flatMap(baseline => {
      const candidate = optInSamples.find(sample => sample.iteration === baseline.iteration);
      return candidate ? [{ baseline, candidate }] : [];
    });
    const usable = matched.filter(({ baseline, candidate }) => baseline.source && baseline.source === candidate.source &&
      baseline.testsFirstCommit === candidate.testsFirstCommit && qualityPassed(baseline) && qualityPassed(candidate) &&
      baseline.activeMs !== undefined && candidate.activeMs !== undefined);
    const baseTime = stats(usable.map(pair => pair.baseline.activeMs!));
    const optTime = stats(usable.map(pair => pair.candidate.activeMs!));
    const baseline = summarizeArm(baselineSamples);
    const optIn = summarizeArm(optInSamples);
    const latencyChange = change(baseTime?.median, optTime?.median);
    const tokenChange = change(baseline.totalTokens, optIn.totalTokens);
    const costChange = change(baseline.reportedCostUsd, optIn.reportedCostUsd);
    const gates = {
      live,
      toolsEnabled,
      atLeastTenPairs: usable.length >= 10,
      everyPlannedPairPassed: usable.length === iterations,
      medianAtLeast15PercentLower: latencyChange !== null && latencyChange <= -15,
      noMoreFailuresOrRetries: optIn.failures <= baseline.failures && optIn.failedCalls <= baseline.failedCalls && optIn.retries <= baseline.retries,
      tokenWorkWithin10Percent: tokenChange !== null && tokenChange <= 10,
      costWithin10Percent: costChange !== null && costChange <= 10,
    };
    return [id, { baseline, optIn, matchedPairs: matched.length, qualityPassingPairs: usable.length,
      baselineActiveMs: baseTime, optInActiveMs: optTime, activeChangePercent: latencyChange,
      tokenChangePercent: tokenChange, costChangePercent: costChange,
      p95Preliminary: usable.length < 20, gates,
      recommendation: Object.values(gates).every(Boolean) ? "eligible-for-blind-review" : "hold" }];
  }));
}

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: "boolean" }, offline: { type: "boolean" }, config: { type: "string" },
    cases: { type: "string" }, iterations: { type: "string", default: "1" },
    "timeout-ms": { type: "string", default: "90000" }, "max-calls": { type: "string" },
    directory: { type: "string" }, "embedded-source": { type: "boolean" }, "reasoning-effort": { type: "string" },
    "unit-runtime-ready": { type: "boolean" },
    "codex-quota": { type: "boolean" },
    "parallel-pairs": { type: "string", default: "1" },
  } });
  const ids = (values.cases?.split(",") ?? Object.keys(cases)) as CaseId[];
  if (!ids.length || ids.some(id => !Object.hasOwn(cases, id)) || new Set(ids).size !== ids.length)
    throw new Error(`Select unique case IDs: ${Object.keys(cases).join(", ")}`);
  const iterations = number(values.iterations!, "--iterations", 1, 20);
  const parallelPairs = Math.min(ids.length, number(values["parallel-pairs"]!, "--parallel-pairs", 1, Object.keys(cases).length));
  const timeoutMs = number(values["timeout-ms"]!, "--timeout-ms", 100, 600000);
  const callsPerMatrix = ids.reduce((count, id) => count + (cases[id].mode === "checks" ? 2 : cases[id].mode === "proposals" ? 3 : 4), 0);
  const plannedCalls = iterations * callsPerMatrix;
  const maxCalls = values["max-calls"] ? number(values["max-calls"], "--max-calls", 1, 1000) : callsPerMatrix;
  if (values.live && values.offline) throw new Error("Select one of --live or --offline.");
  if (!values.live && !values.offline) {
    console.log(JSON.stringify({ cases: ids, iterations, parallelPairs, plannedCalls, next: "Use --offline for fixtures or --live --config <pinned-role.json> for provider calls." }, null, 2));
    return;
  }
  if (values.live && (!values.config || plannedCalls > maxCalls))
    throw new Error(`Live qualification requires --config and a call cap of at least ${plannedCalls}. Use --max-calls for multiple iterations.`);
  const author: RoleConfig = values.config ? JSON.parse(readFileSync(path.resolve(values.config), "utf8")) : { provider: "codex", model: "fixture" };
  if (!author || !["codex", "claude", "deepseek"].includes(author.provider) || typeof author.model !== "string" || !author.model.trim())
    throw new Error("Supply an explicit provider and model in the role configuration.");
  const effort = values["reasoning-effort"];
  if (effort !== undefined && (author.provider !== "codex" || !["low", "medium", "high", "xhigh"].includes(effort)))
    throw new Error("--reasoning-effort requires Codex and low, medium, high, or xhigh.");
  const codexReasoningEffort = effort as ProviderRequest["codexReasoningEffort"];
  if (values["codex-quota"] && (!values.live || author.provider !== "codex"))
    throw new Error("--codex-quota requires a live Codex run.");

  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = path.resolve(values.directory ?? path.join(root, ".kitchen/benchmarks", `live-stations-${randomUUID()}`));
  mkdirSync(path.dirname(directory), { recursive: true });
  mkdirSync(directory);
  const fixture = path.join(directory, "fixture");
  const baseCommit = await createQualificationFixture(fixture);
  // Match the prerequisite commit IDs across arms as well as the file bytes.
  process.env.GIT_AUTHOR_DATE = "2000-01-01T00:00:00Z";
  process.env.GIT_COMMITTER_DATE = "2000-01-01T00:00:00Z";
  const samples: Sample[] = [];
  const live = values.live === true;
  const toolsEnabled = values["embedded-source"] !== true;
  let calls = 0;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const reportFile = path.join(directory, "report.json");
  const quota: Array<{ afterIteration: number; snapshot?: Awaited<ReturnType<typeof codexQuota>>; error?: string }> = [];
  const captureQuota = async (afterIteration: number) => {
    if (!values["codex-quota"]) return;
    try { quota.push({ afterIteration, snapshot: await codexQuota(author, root) }); }
    catch (error) { quota.push({ afterIteration, error: error instanceof Error ? error.message : String(error) }); }
  };
  const save = () => {
    writeFileSync(reportFile + ".tmp", JSON.stringify({
      live, toolsEnabled, author, codexReasoningEffort: codexReasoningEffort ?? null, baseCommit, fixture, cases: ids, iterations, parallelPairs, plannedCalls, maxCalls,
      callsStarted: calls, cancelled: controller.signal.aborted, quota, samples, comparisons: compare(samples, ids, iterations, live, toolsEnabled),
      qualityReview: "Fixture checks and a seeded-defect signal. Human blind review is required before rollout.",
    }, null, 2) + "\n");
    replaceFileSync(reportFile + ".tmp", reportFile);
  };
  const runSample = async (id: CaseId, iteration: number, arm: Arm) => {
    const target = cases[id].station;
    // Detached baseline worktrees add another run ID below this path.
    const workRoot = path.join(directory, `${iteration}-${ids.indexOf(id) + 1}-${arm === "baseline" ? "b" : "o"}`);
    const sample: Sample = { case: id, iteration, arm, root: workRoot, status: "setting-up", quality: {}, calls: [] };
    samples.push(sample);
    const pinned = fixtureProvider(target);
    let measured = false;
    let started: number | undefined;
    let worktree: string | undefined;
    let embeddedSource = "";
    try {
      cpSync(fixture, workRoot, { recursive: true });
      writeFileSync(path.join(workRoot, "kitchen.config.json"), JSON.stringify(fixtureConfig(id, arm === "opt-in", author, timeoutMs), null, 2));
      const kitchen = new Kitchen({ root: workRoot, provider: async req => {
        if (!measured || !live) return pinned(req);
        if (calls >= maxCalls || controller.signal.aborted) throw new Error("Live qualification call limit or cancellation reached.");
        calls++;
        const call: Call = { role: req.role, kind: req.kind ?? "author", evidence: req.runDir, status: "running", attempts: [] };
        sample.calls.push(call);
        save();
        try {
          const result = await cliProvider({ ...req, codexReasoningEffort,
            ...(toolsEnabled ? {} : { noTools: true, prompt: `${req.prompt}\n\nFROZEN FIXTURE SOURCE (use the supplied text for repository evidence)\n${embeddedSource}` }),
            onMetrics: attempt => { call.attempts.push(attempt); req.onMetrics?.(attempt); },
          });
          call.status = "completed";
          return result;
        } catch (error) {
          call.status = "failed";
          call.error = error instanceof Error ? error.message : String(error);
          throw error;
        } finally { save(); }
      } });
      const state = await kitchen.start(feature, { request });
      worktree = state.worktree;
      for (const station of stationOrder.slice(0, stationOrder.indexOf(target))) {
        await kitchen.run(feature, station, { signal: controller.signal });
        // Only the checked-in fixture's deterministic prerequisites receive
        // synthetic approvals. Measured outputs always stop at the real gate.
        await kitchen.approve(feature, station, { actor: "qualification-fixture" });
      }
      const ready = await kitchen.status(feature);
      sample.source = await sourceFingerprint(worktree, feature);
      sample.testsFirstCommit = ready.testsFirstCommit;
      if (target === "unit-tests" && values["unit-runtime-ready"])
        sample.fixedFeedback = "Both fixture unit profiles already run from the pinned base using check.mjs and Node builtins. Neither profile has setup, and no runtime support changes are needed. A null RUNNER PREPARATION is expected for this fixture. Proceed with the approved case table proposals.";
      if (!toolsEnabled) {
        embeddedSource = (await sourceFiles(worktree, feature)).sort().flatMap(file => {
          const absolute = safePath(worktree!, file);
          return existsSync(absolute) ? [`FILE ${file}\n${readFileSync(absolute, "utf8")}`] : [];
        }).join("\n\n");
        if (Buffer.byteLength(embeddedSource) > 128 * 1024)
          throw new Error("Embedded fixture source exceeds 128 KiB.");
      }
      measured = true;
      sample.status = "running";
      started = performance.now();
      await kitchen.run(feature, target, { feedback: sample.fixedFeedback,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs * 3 + 15000)]) });
    } catch (error) {
      sample.status = measured ? "failed" : "setup-failed";
      sample.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (started !== undefined) sample.activeMs = performance.now() - started;
      if (measured && worktree) {
        const record = new Storage(workRoot).read(feature).stations[target];
        if (record) {
          sample.status = record.status;
          sample.runId = record.runId;
          sample.humanWaitMs = record.metrics?.humanWaitMs;
          sample.phases = record.metrics?.phases;
          sample.activeMs = record.metrics?.durationMs ?? sample.activeMs;
          sample.findings = record.findings;
          sample.checks = record.checks;
        }
        try { sample.quality = await scoreFixture(target, record, worktree, controller.signal); }
        catch (error) {
          sample.quality = { scoringCompleted: false };
          sample.error ??= error instanceof Error ? error.message : String(error);
        }
      }
      save();
      console.error(`${id} ${iteration} ${arm}: ${sample.status}; quality=${qualityPassed(sample) ? "passed" : "failed"}; calls=${sample.calls.length}`);
    }
  };

  save();
  console.error(`Report: ${reportFile}`);
  try {
    await captureQuota(0);
    for (let iteration = 1; iteration <= iterations && !controller.signal.aborted; iteration++) {
      const queue = ids.map((_, index) => (index + iteration - 1) % ids.length).values();
      const runPairs = async () => {
        for (const index of queue) {
          const id = ids[index]!;
          const order: Arm[] = (iteration + index) % 2 ? ["baseline", "opt-in"] : ["opt-in", "baseline"];
          for (const arm of order) {
            if (controller.signal.aborted) return;
            await runSample(id, iteration, arm);
          }
        }
      };
      await Promise.all(Array.from({ length: parallelPairs }, runPairs));
      if (iteration === 1 || iteration % 5 === 0 || iteration === iterations || controller.signal.aborted) {
        await captureQuota(iteration);
        save();
      }
    }
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    save();
  }
  console.log(JSON.stringify({ reportFile, samples: samples.length, callsStarted: calls,
    qualityPassed: samples.filter(qualityPassed).length }, null, 2));
  if (controller.signal.aborted || samples.length !== ids.length * iterations * 2 || samples.some(sample => !qualityPassed(sample))) process.exitCode = 1;
}

await main();
