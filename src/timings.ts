import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { validateFeature } from "./domain.ts";
import type { ProviderMetrics, RunMetrics, Station } from "./types.ts";

export function intervalUnion(intervals: Array<[number, number]>): number {
  let total = 0, end = -Infinity;
  for (const [start, stop] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}
export interface TimingAttempt {
  evidence: string;
  station?: Station;
  role?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status: string;
  terminationReason?: string;
  error?: string;
  spans?: ProviderMetrics["spans"];
}
export interface TimingRun {
  runId: string;
  station?: Station;
  status: string;
  error?: string;
  activeMs?: number;
  humanWaitMs?: number;
  providerWorkMs: number;
  providerElapsedMs?: number;
  partial: boolean;
  attempts: TimingAttempt[];
}
export function readTimings(root: string, feature: string) {
  validateFeature(feature);
  const directory = path.join(root, ".kitchen/features", feature, "runs");
  if (!existsSync(directory)) throw new Error(`No saved runs for ${feature}.`);
  const warnings: string[] = [];
  const read = (file: string): Record<string, any> | undefined => {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch { warnings.push(`Unreadable evidence: ${file}`); return; }
  };
  const intervals: Array<[number, number]> = [];
  const runs: TimingRun[] = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const runDir = path.join(directory, entry.name);
    const metrics = existsSync(path.join(runDir, "metrics.json"))
      ? read(path.join(runDir, "metrics.json")) as RunMetrics | undefined : undefined;
    const attempts: TimingAttempt[] = [];
    const visit = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const role of ["author", "review"] as const) {
        const processFile = path.join(dir, `${role}-process.json`);
        const liveFile = path.join(dir, `${role}-live.json`);
        const hasProcess = existsSync(processFile);
        const record = hasProcess ? read(processFile) : existsSync(liveFile) ? read(liveFile) : undefined;
        const timingFile = path.join(dir, `${role}-timing-events.jsonl`);
        if (!record && !existsSync(timingFile)) continue;
        const m = (hasProcess ? record?.metrics : record) as ProviderMetrics | undefined;
        let station = m?.station;
        if (!station && existsSync(path.join(dir, `${role}-prompt.txt`))) {
          const prompt = readFileSync(path.join(dir, `${role}-prompt.txt`), "utf8");
          station = /at the ([\w-]+) station/.exec(prompt)?.[1] as Station | undefined;
        }
        let lastEvent: any;
        if (!record && existsSync(timingFile)) {
          for (const line of readFileSync(timingFile, "utf8").trim().split(/\r?\n/)) {
            try { lastEvent = JSON.parse(line); } catch { /* A killed append may be partial. */ }
          }
        }
        attempts.push({
          evidence: path.relative(root, dir).replaceAll("\\", "/"), station, role,
          provider: record?.provider ?? m?.provider, model: record?.model ?? m?.model,
          sessionId: m?.sessionId, startedAt: record?.startedAt ?? m?.startedAt,
          completedAt: record?.finishedAt ?? m?.completedAt,
          durationMs: m?.durationMs ?? lastEvent?.elapsedMs,
          status: !hasProcess ? "incomplete" : record?.cancelled ? "cancelled" : record?.timedOut ? "timed-out"
            : record?.validationError || record?.code !== 0 ? "failed" : "completed",
          terminationReason: m?.terminationReason ?? m?.tokens?.terminationReason,
          error: record?.validationError ?? record?.failureReason, spans: m?.spans,
        });
      }
      for (const child of entries)
        if (child.isDirectory() && !child.name.endsWith("-dsh-home") && child.name !== "node_modules") visit(path.join(dir, child.name));
    };
    visit(runDir);
    const spans = attempts.flatMap(attempt => {
      const start = Date.parse(attempt.startedAt ?? "");
      if (!Number.isFinite(start) || attempt.durationMs === undefined) return [];
      return [[start, start + attempt.durationMs] as [number, number]];
    });
    intervals.push(...spans);
    return {
      runId: entry.name, station: metrics?.station ?? attempts.find(attempt => attempt.station)?.station,
      status: metrics?.status ?? (attempts.some(a => a.status !== "completed") ? "incomplete-or-failed" : "historical-outcome-unavailable"),
      error: metrics?.error, activeMs: metrics?.durationMs, humanWaitMs: metrics?.humanWaitMs,
      providerWorkMs: attempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0),
      providerElapsedMs: spans.length ? intervalUnion(spans) : undefined,
      partial: !metrics?.completedAt || attempts.some(attempt => attempt.status === "incomplete"), attempts,
    };
  });
  return {
    feature, runs, warnings,
    totals: {
      runs: runs.length, measuredRuns: runs.filter(run => run.activeMs !== undefined).length,
      partialRuns: runs.filter(run => run.partial).length,
      activeMs: runs.reduce((sum, run) => sum + (run.activeMs ?? 0), 0),
      humanWaitMs: runs.reduce((sum, run) => sum + (run.humanWaitMs ?? 0), 0),
      providerWorkMs: runs.reduce((sum, run) => sum + run.providerWorkMs, 0),
      providerElapsedMs: intervals.length ? intervalUnion(intervals) : undefined,
    },
  };
}
export function renderTimings(report: ReturnType<typeof readTimings>): string {
  const seconds = (value?: number) => value === undefined ? "unavailable" : (value / 1000).toFixed(2);
  return [
    `# Timing evidence: ${report.feature}`,
    "Active time excludes recorded human wait. Provider work sums attempts; provider elapsed unions their intervals, including concurrent discovery. Partial durations are lower bounds. Historical station outcomes may be unavailable.",
    "| Run | Station | Status | Active seconds | Provider work seconds | Provider elapsed seconds |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...report.runs.map(run => `| ${run.runId} | ${run.station ?? "unavailable"} | ${run.status}${run.partial ? " (partial)" : ""} | ${seconds(run.activeMs)} | ${seconds(run.providerWorkMs)} | ${seconds(run.providerElapsedMs)} |`),
    `Measured active time: ${seconds(report.totals.activeMs)} s across ${report.totals.measuredRuns} runs. Partial runs: ${report.totals.partialRuns}.`,
    ...report.warnings,
  ].join("\n\n");
}
