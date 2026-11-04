import { performance } from "node:perf_hooks";
import type { RunMetrics } from "./types.ts";
import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";

const checkpoints = new WeakMap<RunMetrics, () => void>();
export function persistMetrics(metrics: RunMetrics, directory: string): () => void {
  const save = () => {
    const file = path.join(directory, "metrics.json");
    writeFileSync(file + ".tmp", JSON.stringify(metrics, null, 2));
    renameSync(file + ".tmp", file);
  };
  checkpoints.set(metrics, save);
  save();
  return save;
}

export function runMetrics(): RunMetrics {
  return {
    startedAt: new Date().toISOString(),
    humanWaitMs: 0,
    phases: [],
    promptBytes: [],
    providers: [],
  };
}

export async function timed<T>(
  metrics: RunMetrics | undefined,
  phase: string,
  action: () => Promise<T>,
  onProgress?: (message: string) => void,
): Promise<T> {
  onProgress?.(`Preparing ${phase}…`);
  const started = performance.now();
  try {
    return await action();
  } finally {
    metrics?.phases.push({ phase, durationMs: performance.now() - started });
    if (metrics) checkpoints.get(metrics)?.();
  }
}

export function promptSections(prompt: string): Record<string, number> {
  const sections: Record<string, number> = {};
  let name = "instructions";
  for (const line of prompt.split(/(?<=\n)/)) {
    const heading =
      /^(Human\/model conversation|Rubric|Station boundaries|Existing template|Context|Human revision request|KITCHEN OUTPUT CONTRACT|DOCUMENT [^\n]+|CHECK PROFILES|LOCAL RUN STATE|RUNNER PREPARATION|DISCOVERY|DIFF|UNTRACKED FILES)/.exec(
        line,
      );
    if (heading) name = heading[1]!;
    sections[name] = (sections[name] ?? 0) + Buffer.byteLength(line);
  }
  return sections;
}
