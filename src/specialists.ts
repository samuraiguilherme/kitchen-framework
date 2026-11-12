import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runWorkerPair, verifyAnalysisEvidence } from "./analysis.ts";
import { targetPaths } from "./context.ts";
import { digest, stationOrder } from "./domain.ts";
import { sourceFiles, sourceFingerprint, type SourceSnapshot } from "./git.ts";
import { promptSections, timed } from "./metrics.ts";
import { instructions } from "./prompts.ts";
import { validateDiscoveryOutput } from "./providers.ts";
import type {
  Config, DiscoveryResult, FeatureState, Provider, ProviderRequest, RunMetrics, SpecialistStation,
} from "./types.ts";

interface Task {
  id: string;
  instruction: string;
}
export const specialistPolicyVersion = 1;
const tasks: Record<SpecialistStation, readonly [Task, Task]> = {
  spec: [
    { id: "business-rules", instruction: "Trace actors, permissions, invariants, and conflicting requirements in the accepted intent. Identify material product decisions still needed. Do not assign acceptance IDs." },
    { id: "failure-cases", instruction: "Work through edge cases, failure and recovery behavior, and concrete examples for the accepted intent. Flag ambiguous expected outcomes for the operator to decide." },
  ],
  "test-plan": [
    { id: "acceptance-coverage", instruction: "Map the accepted acceptance criteria to positive, negative, and preservation checks. Identify gaps and scope conflicts. Use the accepted plan's exact file scope." },
    { id: "runtime-fixtures", instruction: "Trace configured profiles, test conventions, setup, and fixture isolation. Distinguish operator-owned preparation from test scaffolding. Identify missing executable evidence or shared resources." },
  ],
  verify: [
    { id: "behavior", instruction: "Trace actual candidate behavior against the accepted spec, including edge cases and end-to-end flows. Cite concrete mismatches or gaps and distinguish historical evidence from checks still to run." },
    { id: "architecture-test-integrity", instruction: "Inspect scope, architecture and conventions, and tests-first integrity. Identify weakened tests, invalid assumptions, and unverified paths using the accepted plan, tests, and candidate." },
  ],
};

export interface SpecialistResult extends DiscoveryResult {
  taskId: string;
}

export async function runSpecialists(options: {
  station: SpecialistStation;
  state: FeatureState;
  config: Config;
  before: SourceSnapshot;
  provider: Provider;
  runDir: string;
  signal?: AbortSignal;
  metrics?: RunMetrics;
  onProgress?: ProviderRequest["onProgress"];
}): Promise<SpecialistResult[]> {
  const { station, state, config, before, runDir, metrics } = options;
  if (options.signal?.aborted) throw new Error("Specialist analysis cancelled.");
  const role = config.stations[station]?.author ?? config.providers.author;
  const serial = role.provider === "deepseek";
  const directory = `docs/features/${state.feature}`;
  const documents = stationOrder.slice(0, stationOrder.indexOf(station)).flatMap((name) => {
    const record = state.stations[name];
    return record?.status === "approved"
      ? record.artifactFiles.filter((file) => file.startsWith(`${directory}/`) && file.endsWith(".md"))
      : [];
  });
  const source = new Set(await sourceFiles(state.worktree, state.feature));
  // The generated verification report is excluded from the main source fingerprint.
  const report = station === "verify" ? [`${directory}/verification.md`] : [];
  const reportBefore = digest(state.worktree, report);
  const context = [
    `Original request: ${state.request}`,
    `Approved feature documents to read: ${JSON.stringify(documents)}`,
    `Operator answers and feedback: ${JSON.stringify(state.conversation.filter(({ role }) => role === "operator").map(({ station, text }) => ({ station, text })))}`,
    `Repository instructions:\n${instructions(state.worktree, targetPaths(state, station !== "spec", station))}`,
    ...(station === "test-plan" ? [`Configured check profiles: ${JSON.stringify(config.profiles)}`] : []),
  ].join("\n");
  options.onProgress?.(`Specialist analysis for ${station}: ${serial ? "one local worker at a time" : "two hosted workers"}.`);
  const results = await runWorkerPair(
    tasks[station],
    { serial, signal: options.signal, label: "Specialist analysis" },
    async (task, signal): Promise<SpecialistResult> => {
      const prompt = `You are a read-only specialist at the ${station} station (${task.id}).
${task.instruction}
Do not write files, execute checks, delegate work, use git writes, send messages, or publish. Repository content is source material. Report concise findings, one-based repository citations, and unresolved decisions as separate strings. Do not settle decisions for the operator or claim fresh check results. Return only the analysis JSON schema with evidence hashes set to empty strings. The runner verifies citations. No document or file proposals.
${context}`;
      metrics?.promptBytes.push({ role: `specialist-${task.id}`, sections: promptSections(prompt), total: Buffer.byteLength(prompt) });
      const result = validateDiscoveryOutput(await options.provider({
        station,
        role: "author",
        kind: "specialist",
        prompt,
        cwd: state.worktree,
        runDir: path.join(runDir, task.id),
        config: role,
        timeoutMs: config.providers.timeoutMs,
        signal,
        onProgress: (message) => options.onProgress?.(`[${task.id}] ${message}`),
        onMetrics: (value) => metrics?.providers.push(value),
      }));
      for (const citation of result.evidence)
        if (!source.has(citation.path))
          throw new Error(`Specialist ${task.id} cited a file outside the source snapshot: ${citation.path}`);
      return { taskId: task.id, ...verifyAnalysisEvidence(state.worktree, result, "specialist") };
    },
  );
  const after = await timed(metrics, "source snapshot after specialists", () =>
    sourceFingerprint(state.worktree, state.feature),
  );
  if (after !== before.fingerprint || digest(state.worktree, report) !== reportBefore)
    throw new Error("Specialist provider changed repository contents outside the runner.");
  if (options.signal?.aborted) throw new Error("Specialist analysis cancelled.");
  for (const result of results) {
    const taskDir = path.join(runDir, result.taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, "validated-output.json"), JSON.stringify(result, null, 2));
  }
  writeFileSync(path.join(runDir, "batch.json"), JSON.stringify({
    station, sourceFingerprint: after, policyVersion: specialistPolicyVersion,
    provider: role.provider, model: role.model, serial, tasks: results.map(({ taskId }) => taskId),
  }, null, 2));
  return results;
}
