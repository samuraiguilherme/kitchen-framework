import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assetsRoot, rubric } from "./prompts.ts";
import { cliProvider, validateReviewOutput } from "./providers.ts";
import { loadConfig } from "./config.ts";
import type { Provider, Station } from "./types.ts";

export async function evaluate(
  root: string,
  station: Station,
  options: {
    labels?: string;
    live?: boolean;
    signal?: AbortSignal;
    provider?: Provider;
  } = {},
): Promise<{
  measured: boolean;
  labeled: number;
  missedProblems?: number;
  unnecessaryFindings?: number;
  [key: string]: unknown;
}> {
  const examples = JSON.parse(
    readFileSync(path.join(assetsRoot, "examples", `${station}.json`), "utf8"),
  );
  const labels = options.labels
    ? JSON.parse(readFileSync(options.labels, "utf8"))
    : {};
  for (const id of Object.keys(labels))
    if (
      !examples.examples.some((e: { id: string }) => e.id === id) ||
      !["acceptable", "flawed"].includes(labels[id])
    )
      throw new Error(
        "Labels must map known example IDs to acceptable or flawed.",
      );
  const dir = path.join(root, ".kitchen", "evaluations", station, randomUUID());
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "labels.json"), JSON.stringify(labels, null, 2));
  const cases = examples.examples.filter((e: { id: string }) => labels[e.id]);
  if (!options.live || !cases.length)
    return {
      rubricVersion: examples.version,
      examples: examples.examples,
      labeled: cases.length,
      measured: false,
      reason:
        "Inspect/label examples, then pass --labels <file> --live for opt-in independent model evaluation.",
      evidence: dir,
    };
  const config = loadConfig(root);
  const results = [];
  for (const example of cases) {
    const output = validateReviewOutput(
      await (options.provider ?? cliProvider)({
        station,
        role: "review",
        cwd: root,
        runDir: path.join(dir, example.id),
        config: config.stations[station]?.review ?? config.providers.review,
        timeoutMs: config.providers.timeoutMs,
        signal: options.signal,
        prompt: `Evaluate this candidate using the following rubric. Return structured findings with concrete evidence. A candidate may be acceptable.\n${rubric(station)}\nCONTEXT:\n${example.context ?? ""}\nCANDIDATE:\n${example.candidate}`,
      }),
    );
    const prediction = output.findings.some((f) => f.blocking)
      ? "flawed"
      : "acceptable";
    results.push({
      id: example.id,
      label: labels[example.id],
      prediction,
      findings: output.findings,
    });
  }
  const result = {
    rubricVersion: examples.version,
    labeled: cases.length,
    measured: true,
    missedProblems: results.filter(
      (r) => r.label === "flawed" && r.prediction === "acceptable",
    ).length,
    unnecessaryFindings: results.filter(
      (r) => r.label === "acceptable" && r.prediction === "flawed",
    ).length,
    cases: results,
    evidence: dir,
  };
  writeFileSync(
    path.join(dir, "results.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
