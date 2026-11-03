import { performance } from "node:perf_hooks";
import type { RunMetrics } from "./types.ts";

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
