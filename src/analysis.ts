import { readFileSync } from "node:fs";
import { hash, safePath } from "./domain.ts";
import type { DiscoveryResult } from "./types.ts";

export function verifyAnalysisEvidence(
  root: string,
  result: DiscoveryResult,
  label: string,
): DiscoveryResult {
  return {
    ...result,
    evidence: result.evidence.map((citation) => {
      const content = readFileSync(safePath(root, citation.path), "utf8");
      if (citation.line > content.split(/\r?\n/).length)
        throw new Error(`Invalid ${label} citation: ${citation.path}:${citation.line}`);
      return { ...citation, hash: hash(content) };
    }),
  };
}

export async function runWorkerPair<T, R>(
  tasks: readonly [T, T],
  options: { serial: boolean; label: string; signal?: AbortSignal },
  run: (task: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const runTask = async (task: T) => {
    if (signal.aborted) throw new Error(`${options.label} cancelled.`);
    const result = await run(task, signal);
    if (signal.aborted) throw new Error(`${options.label} cancelled.`);
    return result;
  };
  if (options.serial) return [await runTask(tasks[0]), await runTask(tasks[1])];

  const pending = tasks.map(runTask);
  try {
    return await Promise.all(pending);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(pending);
    throw error;
  }
}
