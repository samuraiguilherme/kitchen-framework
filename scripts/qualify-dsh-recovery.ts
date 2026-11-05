// Replay a saved document author prompt without changing its project's Kitchen
// state. All generated candidates and measurements stay in a new evidence dir.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { cliProvider } from "../src/providers.ts";
import { checkDeepSeekModel, validateDeepSeekConfig } from "../src/deepseek.ts";
import { sourceSnapshot } from "../src/git.ts";
import { lintDocument } from "../src/domain.ts";
import type { AuthorOutput, ProviderMetrics, RoleConfig, Station } from "../src/types.ts";

const { values } = parseArgs({ options: {
  evidence: { type: "string" }, config: { type: "string" }, output: { type: "string" },
  iterations: { type: "string", default: "3" },
} });
if (!values.evidence || !values.config) throw new Error("Use --evidence <saved role directory> --config <provider config.json> [--iterations 3].");
const evidence = path.resolve(values.evidence);
const saved = JSON.parse(readFileSync(path.join(evidence, "author-process.json"), "utf8"));
const supplied = JSON.parse(readFileSync(path.resolve(values.config), "utf8"));
const config: RoleConfig = supplied.providers.author;
validateDeepSeekConfig(config);
const iterations = Number(values.iterations);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10) throw new Error("Use 1–10 iterations.");
const timeoutMs = supplied.providers.timeoutMs ?? 1200000;
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error("Invalid qualification timeout.");
const directory = path.resolve(values.output ?? `.kitchen/validation/dsh-recovery-${randomUUID()}`);
if (existsSync(directory)) throw new Error("Choose a fresh output directory to preserve evidence.");
mkdirSync(directory, { recursive: true });
const originalPrompt = readFileSync(path.join(evidence, "author-prompt.txt"), "utf8");
const marker = originalPrompt.lastIndexOf("\n\nKITCHEN OUTPUT CONTRACT\n");
if (marker < 0) throw new Error("Saved prompt has no Kitchen output contract boundary.");
const prompt = originalPrompt.slice(0, marker);
const station = saved.metrics.station as Station;
if (!["intent", "spec", "plan", "test-plan"].includes(station)) throw new Error("Replay currently supports author document stations.");
const cwd = path.resolve(saved.cwd);
const source = await sourceSnapshot(cwd, "dsh-recovery-qualification");
const identity = await checkDeepSeekModel(config, 10000);
const pinned = { ...config, dsh: { ...config.dsh!, expectedModelDigest: identity.digest } };
writeFileSync(path.join(directory, "original-process.json"), JSON.stringify(saved, null, 2));
writeFileSync(path.join(directory, "config.json"), JSON.stringify({ providers: { author: pinned, timeoutMs } }, null, 2));
const samples: Array<Record<string, unknown>> = [];
const report = () => {
  const result = { evidence, station, cwd, sourceFingerprint: source.fingerprint, identity,
    promptHash: createHash("sha256").update(prompt).digest("hex"), iterations, samples,
    qualified: samples.length === iterations && samples.every(value => value.valid === true && value.allocationVerified === true),
    scope: "Complete schema/station-valid documents, required template sections and verified allocation. Review requirement coverage separately before changing project configuration.",
  };
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(result, null, 2));
  return result;
};
report();
for (let iteration = 1; iteration <= iterations; iteration++) {
  if ((await sourceSnapshot(cwd, "dsh-recovery-qualification")).fingerprint !== source.fingerprint)
    throw new Error("Original project changed during qualification; retain evidence and rerun.");
  const metrics: ProviderMetrics[] = [];
  const sample: Record<string, unknown> = { iteration, valid: false };
  const runDir = path.join(directory, `replay-${iteration}`);
  try {
    const output = await cliProvider({ station, role: "author", prompt, cwd, runDir,
      config: pinned, timeoutMs, onMetrics: value => metrics.push(value), onProgress: value => console.log(value),
    }) as AuthorOutput;
    const findings = output.document ? lintDocument(station, output.document) : ["No document returned"];
    sample.valid = !output.questions.length && findings.length === 0;
    sample.findings = findings;
    const attempts = existsSync(path.join(runDir, "author-attempts.json"))
      ? JSON.parse(readFileSync(path.join(runDir, "author-attempts.json"), "utf8")) : undefined;
    const acceptedDir = attempts?.status === "completed" ? attempts.retry.runDir : runDir;
    const process = JSON.parse(readFileSync(path.join(acceptedDir, "author-process.json"), "utf8"));
    sample.allocatedContextWindow = process.deepseek.allocatedContextWindow;
    sample.allocationVerified = process.deepseek.allocatedContextWindow >= pinned.dsh!.contextWindow;
  } catch (error) {
    sample.error = String(error);
  }
  sample.metrics = metrics;
  sample.knownTotalTokens = metrics.reduce((sum, value) => sum + (value.tokens?.knownTotalTokens ?? 0), 0);
  sample.usageComplete = metrics.length > 0 && metrics.every(value => value.tokens?.usageComplete);
  if (sample.usageComplete) sample.totalTokens = sample.knownTotalTokens;
  sample.sourceUnchanged = (await sourceSnapshot(cwd, "dsh-recovery-qualification")).fingerprint === source.fingerprint;
  if (!sample.sourceUnchanged) {
    sample.valid = false;
    sample.error = "Original project changed during qualification; no candidate accepted.";
  }
  samples.push(sample);
  report();
  if (!sample.valid || !sample.allocationVerified) break;
}
const result = report();
console.log(JSON.stringify({ report: path.join(directory, "report.json"), qualified: result.qualified }));
if (!result.qualified) process.exitCode = 1;
