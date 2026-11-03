import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";
import { loadConfig } from "../src/config.ts";
import { buildContext } from "../src/context.ts";
import { lintDocument } from "../src/domain.ts";
import { git, sourceSnapshot } from "../src/git.ts";
import { promptSections } from "../src/metrics.ts";
import { cliProvider, validateAuthorOutput } from "../src/providers.ts";
import { stationPrompt } from "../src/prompts.ts";
import type {
  AuthorOutput,
  FeatureState,
  ProviderMetrics,
} from "../src/types.ts";

const { values } = parseArgs({
  options: {
    "baseline-ref": { type: "string", default: "HEAD" },
    iterations: { type: "string", default: "3" },
    live: { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
    output: { type: "string" },
    "provider-timeout-ms": { type: "string", default: "120000" },
  },
});
const iterations = Number(values.iterations);
const providerTimeoutMs = Number(values["provider-timeout-ms"]);
if (
  !Number.isSafeInteger(providerTimeoutMs) ||
  providerTimeoutMs < 100 ||
  providerTimeoutMs > 3600000
)
  throw new Error(
    "--provider-timeout-ms must be an integer between 100 and 3600000.",
  );
if (values.live && values.offline)
  throw new Error("Select --live or --offline, not both.");
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10)
  throw new Error("--iterations must be an integer between 1 and 10.");
const root = fileURLToPath(new URL("../", import.meta.url));
const id = randomUUID();
const outputDirectory = path.resolve(
  root,
  values.output ?? `.kitchen/benchmarks/${id}`,
);
const config = loadConfig(root);
const author = config.stations.intent?.author ?? config.providers.author;
const timeoutMs = Math.min(config.providers.timeoutMs, providerTimeoutMs);
const baselineRef = await git(
  root,
  "rev-parse",
  "--verify",
  `${values["baseline-ref"]}^{commit}`,
);
const baseCommit = await git(root, "rev-parse", "HEAD");
const request = "Add a sort button to the item board.";
const feedback =
  "Names A-Z/Z-A, loaded cards only, per-column, local until reload";
const question =
  "Which item field and directions should be sorted, over which cards and columns, and should sorting persist?";
const startedAt = new Date().toISOString();
const workload = {
  id,
  startedAt,
  root,
  outputDirectory,
  baselineRef,
  baseCommit,
  iterations,
  providerCalls: values.offline ? 0 : iterations * 4,
  author,
  timeoutMs,
  request,
  feedback,
  offline: values.offline,
  schema: "Current cliProvider author schema for both prompt builders",
  context:
    "Clean synthetic initial feature: empty candidate diff and untracked list. Both providers read the actual shared checkout; its source fingerprint and dirty status are recorded.",
  resume:
    "The same fixed question and operator answer are used in both modes; independently generated initial questions remain raw evidence and do not change the standardized resume workload.",
  sourceGuards:
    "Current full sourceSnapshot before and after every call, timed separately in both modes. This compares prompt builders, not the entire old and new Kitchen runners.",
  sessions:
    "Fresh read-only cliProvider sessions. Provider-side prompt cache/cold starts are not controlled; emitted usage is retained.",
};
if (!values.live && !values.offline) {
  console.log(
    JSON.stringify(
      {
        live: false,
        workload,
        next: "Pass --live to consume model quota. No provider calls or benchmark files were created.",
      },
      null,
      2,
    ),
  );
} else {
  await benchmark();
}

interface PromptBuilder {
  instructions: typeof import("../src/prompts.ts").instructions;
  stationPrompt: typeof stationPrompt;
}
interface Sample {
  iteration: number;
  phase: "initial" | "resume";
  mode: "baseline" | "current";
  startedAt: string;
  finishedAt?: string;
  activeMs?: number;
  beforeFingerprint?: string;
  afterFingerprint?: string;
  fileCount?: number;
  byteCount?: number;
  timings: Record<string, number>;
  promptBytes?: number;
  promptSections?: Record<string, number>;
  providerMetrics?: ProviderMetrics;
  outcome?: {
    questions: number;
    document: boolean;
    files: number;
    blockingDocumentFindings: number;
  };
  error?: string;
}

async function benchmark(): Promise<void> {
  const relativeOutput = path.relative(root, outputDirectory);
  if (!relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput)) {
    const ignored = await git(root, "check-ignore", relativeOutput);
    if (!ignored)
      throw new Error(
        "A benchmark output inside the checkout must be Git-ignored.",
      );
  }
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length)
    throw new Error(
      "Benchmark output already contains evidence; choose an empty directory.",
    );
  mkdirSync(outputDirectory, { recursive: true });
  const actualStatus = await git(root, "status", "--short");
  writeFileSync(
    path.join(outputDirectory, "workload.json"),
    JSON.stringify({ ...workload, actualStatus }, null, 2),
  );
  const baseline = await baselineBuilder();
  const feature = `benchmark-sort-${id.slice(0, 8)}`;
  const initial: FeatureState = {
    version: 1,
    feature,
    request,
    baseCommit,
    branch: "synthetic-no-branch-created",
    worktree: root,
    stations: {},
    conversation: [
      { role: "operator", station: "intent", text: request, at: startedAt },
    ],
  };
  const blank: AuthorOutput = {
    summary: "",
    questions: [{ id: "sort-behavior", text: question }],
    document: null,
    files: [],
    allowedPaths: [],
    unitTestFiles: [],
    scaffoldFiles: [],
    checks: [],
  };
  const resumed: FeatureState = {
    ...initial,
    stations: {
      intent: {
        status: "awaiting-input",
        runId: "standardized-question-round",
        rubricVersion: "1.0.0",
        profileVersions: {},
        findings: [],
        checks: [],
        summary: "",
        artifactFiles: [],
        output: blank,
      },
    },
    conversation: [
      ...initial.conversation,
      { role: "model", station: "intent", text: question, at: startedAt },
      { role: "operator", station: "intent", text: feedback, at: startedAt },
    ],
  };
  const samples: Sample[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    benchmarkLoop: for (
      let iteration = 1;
      iteration <= iterations;
      iteration++
    ) {
      // Alternate the first mode to reduce systematic warm-cache ordering bias.
      const modes =
        iteration % 2
          ? (["baseline", "current"] as const)
          : (["current", "baseline"] as const);
      for (const phase of ["initial", "resume"] as const) {
        for (const mode of modes) {
          if (controller.signal.aborted) break benchmarkLoop;
          const state = phase === "initial" ? initial : resumed;
          const sample = await runSample(
            iteration,
            phase,
            mode,
            state,
            baseline,
            controller.signal,
          );
          samples.push(sample);
          writeFileSync(
            path.join(outputDirectory, "samples.json"),
            JSON.stringify(samples, null, 2),
          );
          console.log(JSON.stringify(sample));
          if (sample.error) {
            process.exitCode = 1;
            break benchmarkLoop;
          }
        }
      }
    }
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    if (controller.signal.aborted) process.exitCode = 1;
    const comparisons = ["initial", "resume"].map((phase) => ({
      phase,
      pairs: Array.from({ length: iterations }, (_, index) => {
        const baselineSample = samples.find(
          (sample) =>
            sample.iteration === index + 1 &&
            sample.phase === phase &&
            sample.mode === "baseline",
        );
        const currentSample = samples.find(
          (sample) =>
            sample.iteration === index + 1 &&
            sample.phase === phase &&
            sample.mode === "current",
        );
        return {
          iteration: index + 1,
          complete: Boolean(
            baselineSample &&
            currentSample &&
            !baselineSample.error &&
            !currentSample.error,
          ),
          sameSource: Boolean(
            baselineSample &&
            currentSample &&
            baselineSample.beforeFingerprint ===
              currentSample.beforeFingerprint,
          ),
          baselineActiveMs: baselineSample?.activeMs,
          currentActiveMs: currentSample?.activeMs,
          baselineProviderMs: baselineSample?.providerMetrics?.durationMs,
          currentProviderMs: currentSample?.providerMetrics?.durationMs,
        };
      }),
    }));
    writeFileSync(
      path.join(outputDirectory, "summary.json"),
      JSON.stringify(
        {
          workload,
          completedAt: new Date().toISOString(),
          samples: samples.length,
          cancelled: controller.signal.aborted,
          comparisons,
        },
        null,
        2,
      ),
    );
    console.error(`Benchmark evidence: ${outputDirectory}`);
  }
}

async function baselineBuilder(): Promise<PromptBuilder> {
  const directory = path.join(outputDirectory, "baseline");
  mkdirSync(path.join(directory, "src"), { recursive: true });
  mkdirSync(path.join(directory, "rubrics"), { recursive: true });
  const source = await git(
    root,
    "show",
    `${baselineRef}:src/prompts.ts`,
  );
  writeFileSync(path.join(directory, "prompts-source.ts"), source);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const modulePath = path.join(directory, "src/prompts.mjs");
  writeFileSync(modulePath, transpiled.outputText);
  writeFileSync(
    path.join(directory, "rubrics/intent.md"),
    await git(root, "show", `${baselineRef}:rubrics/intent.md`),
  );
  return (await import(pathToFileURL(modulePath).href)) as PromptBuilder;
}

function baselineContext(state: FeatureState, builder: PromptBuilder): string {
  const documents = ["intent", "spec", "plan", "test-plan"].map((name) => {
    const file = `docs/features/${state.feature}/${name}.md`;
    const absolute = path.join(root, file);
    return `DOCUMENT ${file}\n${existsSync(absolute) ? readFileSync(absolute, "utf8") : ""}`;
  });
  return [
    builder.instructions(root),
    ...documents,
    `CHECK PROFILES (human-controlled):\n${JSON.stringify(config.profiles)}`,
    `LOCAL RUN STATE AND EXECUTABLE EVIDENCE:\n${JSON.stringify(state.stations)}`,
    "RUNNER PREPARATION (operator-owned runtime support, not minimal scaffolds):\nnull\nArtifact: not prepared",
    `BASELINE: ${state.baseCommit}; TESTS-FIRST COMMIT: not yet recorded`,
    "DIFF:\n",
    "UNTRACKED FILES:\n",
  ].join("\n\n");
}

async function runSample(
  iteration: number,
  phase: Sample["phase"],
  mode: Sample["mode"],
  state: FeatureState,
  baseline: PromptBuilder,
  signal: AbortSignal,
): Promise<Sample> {
  const sample: Sample = {
    iteration,
    phase,
    mode,
    startedAt: new Date().toISOString(),
    timings: {},
  };
  const started = performance.now();
  const measure = async <T>(name: string, action: () => Promise<T>) => {
    console.error(`[${iteration}/${phase}/${mode}] ${name}`);
    const phaseStarted = performance.now();
    try {
      return await action();
    } finally {
      sample.timings[name] = performance.now() - phaseStarted;
    }
  };
  let before: Awaited<ReturnType<typeof sourceSnapshot>> | undefined;
  try {
    before = await measure("sourceSnapshotBeforeMs", () =>
      sourceSnapshot(root, state.feature),
    );
    sample.beforeFingerprint = before.fingerprint;
    sample.fileCount = before.fileCount;
    sample.byteCount = before.byteCount;
    const prompt = await measure("contextAndPromptMs", async () => {
      const context =
        mode === "baseline"
          ? baselineContext(state, baseline)
          : await buildContext(state, "intent", root);
      const builder =
        mode === "baseline" ? baseline.stationPrompt : stationPrompt;
      return builder(
        state,
        "intent",
        "author",
        context,
        phase === "resume" ? feedback : "",
        false,
      );
    });
    sample.promptBytes = Buffer.byteLength(prompt);
    sample.promptSections = promptSections(prompt);
    if (values.offline) return sample;
    const output = validateAuthorOutput(
      await measure("providerMs", () =>
        cliProvider({
          station: "intent",
          role: "author",
          prompt,
          cwd: root,
          runDir: path.join(
            outputDirectory,
            `iteration-${iteration}`,
            phase,
            mode,
          ),
          config: author,
          timeoutMs,
          signal,
          onProgress: (message) =>
            console.error(`[${iteration}/${phase}/${mode}] ${message}`),
          onMetrics: (metrics) => {
            sample.providerMetrics = metrics;
          },
        }),
      ),
    );
    sample.outcome = {
      questions: output.questions.length,
      document: Boolean(output.document),
      files: output.files.length,
      blockingDocumentFindings: output.document
        ? lintDocument("intent", output.document).filter(
            (finding) => finding.blocking,
          ).length
        : 0,
    };
  } catch (error) {
    sample.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (before) {
      try {
        const after = await measure("sourceSnapshotAfterMs", () =>
          sourceSnapshot(root, state.feature),
        );
        sample.afterFingerprint = after.fingerprint;
        if (after.fingerprint !== before.fingerprint)
          sample.error = `${sample.error ? sample.error + "; " : ""}Source changed during sample; this pair is not controlled evidence.`;
      } catch (error) {
        sample.error = `${sample.error ? sample.error + "; " : ""}Post-provider source guard failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    sample.finishedAt = new Date().toISOString();
    sample.activeMs = performance.now() - started;
  }
  return sample;
}
