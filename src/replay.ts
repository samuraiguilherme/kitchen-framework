import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { acceptanceIds, hash, lintDocument, safePath, stationOrder } from "./domain.ts";
import { git, sourceFiles, sourceSnapshot } from "./git.ts";
import { buildContext } from "./context.ts";
import { stationPrompt } from "./prompts.ts";
import { compactDeepSeek } from "./token-budget.ts";
import { cliProvider, parseProviderOutput, validateAuthorOutput, validateReviewOutput } from "./providers.ts";
import { validateCheckPlan } from "./checks.ts";
import { normalizeTestPlan } from "./test-plan.ts";
import { parseDeepSeekOutput } from "./deepseek.ts";
import type { Config, FeatureState, Provider, ProviderMetrics, RoleConfig, Station } from "./types.ts";

export interface ReplayManifest {
  version: 1;
  capturedAt: string;
  station: Station;
  role: "author" | "review";
  feature: string;
  origin: { evidence: string; configurationRoot: string; worktree: string; stateHash: string };
  recordedProvider: { provider?: string; model?: string };
  sourceAtCapture: string;
  files: Record<string, string>;
  inputs: Record<string, string>;
  profiles: Config["profiles"];
  acIds: string[];
  savedValidation?: { profiles: Config["profiles"]; acIds: string[]; provenance: string };
  config: RoleConfig;
  timeoutMs: number;
}

function fresh(directory: string): string {
  const absolute = path.resolve(directory);
  if (existsSync(absolute)) throw new Error("Choose a fresh output directory; existing evidence is never overwritten.");
  return absolute;
}

function inventory(root: string, directory = "", separateGit = false): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = directory ? `${directory}/${entry.name}` : entry.name;
    if (separateGit && file === ".git") continue;
    if (entry.isSymbolicLink()) throw new Error(`Replay source contains a symlink: ${file}`);
    if (entry.isDirectory()) Object.assign(result, inventory(root, file, separateGit));
    else if (entry.isFile()) result[file] = hash(readFileSync(safePath(root, file)));
    else throw new Error(`Unsupported replay source: ${file}`);
  }
  return result;
}

export function verifyReplayBundle(bundle: string): ReplayManifest {
  const text = readFileSync(path.join(bundle, "manifest.json"), "utf8");
  if (hash(text) !== readFileSync(path.join(bundle, "manifest.sha256"), "utf8").trim())
    throw new Error("Captured replay manifest changed.");
  const manifest: ReplayManifest = JSON.parse(text);
  if (manifest.version !== 1 || !stationOrder.includes(manifest.station) || !["author", "review"].includes(manifest.role))
    throw new Error("Unsupported replay manifest.");
  const files = inventory(path.join(bundle, "source"));
  if (hash(JSON.stringify(files)) !== hash(JSON.stringify(manifest.files))) throw new Error("Captured replay source changed.");
  for (const [file, expected] of Object.entries(manifest.inputs))
    if (hash(readFileSync(safePath(bundle, file))) !== expected) throw new Error(`Captured replay input changed: ${file}`);
  return manifest;
}

// Frozen requests are experiments, never imported approvals or executable checks.
// The saved prompt is historical; current prompt/source/config are captured now.
export async function captureReplay(options: { evidence: string; project: string; output: string; role?: "author" | "review" }): Promise<ReplayManifest> {
  const root = path.resolve(options.project);
  const evidence = path.resolve(options.evidence);
  const role = options.role ?? "author";
  const processRecord = JSON.parse(readFileSync(path.join(evidence, `${role}-process.json`), "utf8"));
  const saved = readFileSync(path.join(evidence, `${role}-prompt.txt`), "utf8");
  const station = processRecord.metrics?.station ?? /at the ([\w-]+) station/.exec(saved)?.[1];
  if (!stationOrder.includes(station)) throw new Error("Saved evidence has no recognized station.");
  const worktree = path.resolve(processRecord.cwd);
  const feature = path.basename(worktree);
  if (worktree !== path.join(root, ".kitchen/worktrees", feature))
    throw new Error("Saved evidence does not belong to the selected project's feature worktree.");
  const stateFile = path.join(root, ".kitchen/features", feature, "state.json");
  const stateText = readFileSync(stateFile, "utf8");
  const state: FeatureState = JSON.parse(stateText);
  if (state.feature !== feature || path.resolve(state.worktree) !== worktree) throw new Error("Feature state does not match saved evidence.");
  const output = fresh(options.output);
  const config = loadConfig(root);
  const selected = config.stations[station as Station]?.[role] ?? config.providers[role];
  const before = await sourceSnapshot(worktree, feature);
  const context = await buildContext(state, station, root, compactDeepSeek(selected), { persist: false });
  const current = stationPrompt(state, station, role, context, "", config.stations[station as Station]?.reviewEnabled, compactDeepSeek(selected));
  mkdirSync(path.join(output, "source"), { recursive: true });
  for (const file of await sourceFiles(worktree, feature)) {
    const from = safePath(worktree, file);
    if (!existsSync(from)) continue; // Tracked deletions are absent in the snapshot.
    const to = safePath(path.join(output, "source"), file);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
  }
  const marker = saved.lastIndexOf("\n\nKITCHEN OUTPUT CONTRACT\n");
  const eventsFile = path.join(evidence, `${role}-events.jsonl`);
  const inputs: Record<string, string> = {};
  const answerFile = path.join(evidence, `${role}-answer.json`);
  const transcript = existsSync(eventsFile) ? readFileSync(eventsFile, "utf8") : processRecord.stdout ?? "";
  for (const [file, content] of Object.entries({
    "saved-prompt.txt": marker >= 0 ? saved.slice(0, marker) : saved,
    "current-prompt.txt": current,
    "events.jsonl": transcript,
    "response.txt": processRecord.provider === "codex"
      ? existsSync(answerFile) ? readFileSync(answerFile, "utf8") : "" : transcript,
    "process.json": JSON.stringify({ code: processRecord.code, cancelled: processRecord.cancelled,
      timedOut: processRecord.timedOut, validationError: processRecord.validationError, failureReason: processRecord.failureReason }),
  })) { writeFileSync(path.join(output, file), content); inputs[file] = hash(content); }
  const spec = path.join(worktree, `docs/features/${feature}/spec.md`);
  const currentAcIds = existsSync(spec) ? acceptanceIds(readFileSync(spec, "utf8")) : [];
  const profileLine = /^CHECK PROFILES \(human-controlled\):\r?\n([^\r\n]+)/m.exec(saved)?.[1];
  const savedProfiles = profileLine ? JSON.parse(profileLine) : undefined;
  const specMarker = `DOCUMENT docs/features/${feature}/spec.md\n`;
  const specStart = saved.replaceAll("\r\n", "\n").indexOf(specMarker);
  const rest = specStart >= 0 ? saved.replaceAll("\r\n", "\n").slice(specStart + specMarker.length) : undefined;
  const boundary = rest?.search(/\n(?:DOCUMENT |REPOSITORY EVIDENCE|LOCAL RUN STATE|CHECK PROFILES|BASELINE:|DIFF |UNTRACKED FILES|Human revision request:)/);
  const savedAcIds = rest === undefined ? undefined : acceptanceIds(boundary !== undefined && boundary >= 0 ? rest.slice(0, boundary) : rest);
  const manifest: ReplayManifest = {
    version: 1, capturedAt: new Date().toISOString(), station, role, feature,
    origin: { evidence, configurationRoot: root, worktree, stateHash: hash(stateText) },
    recordedProvider: { provider: processRecord.provider, model: processRecord.model },
    sourceAtCapture: before.fingerprint, files: inventory(path.join(output, "source")), inputs,
    profiles: Object.fromEntries(Object.entries(config.profiles).map(([id, profile]) => [id, { ...profile, env: undefined }])),
    acIds: currentAcIds,
    savedValidation: { profiles: savedProfiles ?? config.profiles, acIds: savedAcIds ?? currentAcIds,
      provenance: savedProfiles !== undefined && savedAcIds !== undefined ? "saved-request" : "capture-time fallback for fields absent in saved request" },
    config: selected, timeoutMs: config.providers.timeoutMs,
  };
  if ((await sourceSnapshot(worktree, feature)).fingerprint !== before.fingerprint || hash(readFileSync(stateFile, "utf8")) !== manifest.origin.stateHash)
    throw new Error("Project changed during capture; partial evidence retained, no bundle accepted.");
  const manifestText = JSON.stringify(manifest, null, 2);
  writeFileSync(path.join(output, "manifest.json"), manifestText);
  writeFileSync(path.join(output, "manifest.sha256"), hash(manifestText));
  verifyReplayBundle(output);
  return manifest;
}

export function inspectReplayOutput(manifest: Pick<ReplayManifest, "station" | "role" | "profiles" | "acIds">, output: unknown): string[] {
  if (manifest.role === "review") { validateReviewOutput(output); return []; }
  const value = validateAuthorOutput(output, manifest.station);
  if (value.questions.length) return ["Human answers are required; no candidate is ready."];
  const issues: string[] = [];
  if (["intent", "spec", "plan", "test-plan"].includes(manifest.station))
    issues.push(...lintDocument(manifest.station, value.document ?? "").map(finding => `${finding.rule}: ${finding.evidence}`));
  if (manifest.station === "test-plan") {
    const normalized = normalizeTestPlan(value);
    issues.push(...validateCheckPlan(manifest.acIds, normalized.checks, manifest.profiles, normalized.unitTestFiles).map(finding => `${finding.rule}: ${finding.evidence}`));
  }
  return issues;
}

export async function replayStation(options: {
  bundle: string; output: string; live?: boolean; mode?: "saved" | "current";
  config?: RoleConfig; provider?: Provider;
}): Promise<{ valid: boolean; qualityQualified: false; issues: string[]; [key: string]: unknown }> {
  const bundle = path.resolve(options.bundle);
  const manifest = verifyReplayBundle(bundle);
  const directory = fresh(options.output);
  const relative = path.relative(bundle, directory);
  if (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
    throw new Error("Replay output must be outside the captured bundle.");
  const mode = options.mode ?? "saved";
  if (!["saved", "current"].includes(mode)) throw new Error("Replay mode must be saved or current.");
  if (!options.live && mode !== "saved") throw new Error("Rebuilding a candidate from the current prompt requires --live.");
  if (!options.live && options.config) throw new Error("Configuration overrides require an explicit live replay.");
  mkdirSync(directory, { recursive: true });
  const metrics: ProviderMetrics[] = [];
  const issues: string[] = [];
  let output: unknown;
  let sourceUnchanged = true;
  const started = performance.now();
  const config = options.config ?? manifest.config;
  const prompt = readFileSync(path.join(bundle, `${mode}-prompt.txt`), "utf8");
  const cwd = path.join(directory, "source");
  if (options.live) cpSync(path.join(bundle, "source"), cwd, { recursive: true });
  // Codex requires a Git checkout. Keep its metadata outside the frozen source
  // and guard both it and the link; this repository has no remotes or approvals.
  const separateGit = options.live && !options.provider && config.provider === "codex";
  const gitDirectory = path.join(directory, "git");
  if (separateGit) await git(cwd, "init", "--quiet", "--separate-git-dir", gitDirectory);
  const gitIdentity = separateGit ? hash(JSON.stringify(inventory(gitDirectory))) : undefined;
  const gitLink = separateGit ? hash(readFileSync(path.join(cwd, ".git"))) : undefined;
  try {
    if (options.live) output = await (options.provider ?? cliProvider)({
      station: manifest.station, role: manifest.role, cwd, runDir: path.join(directory, "provider"),
      config, prompt, timeoutMs: manifest.timeoutMs, onMetrics: value => metrics.push(value),
    });
    else {
      const recorded = manifest.recordedProvider.provider;
      if (!["deepseek", "codex", "claude"].includes(recorded ?? "")) throw new Error("Saved provider is unknown.");
      const processRecord = JSON.parse(readFileSync(path.join(bundle, "process.json"), "utf8"));
      if (processRecord.code !== 0 || processRecord.cancelled || processRecord.timedOut || processRecord.validationError || processRecord.failureReason)
        throw new Error(`Saved attempt failed: ${processRecord.validationError ?? processRecord.failureReason ?? (processRecord.cancelled ? "cancelled" : processRecord.timedOut ? "timed out" : `exit ${processRecord.code}`)}`);
      const raw = readFileSync(path.join(bundle, "response.txt"), "utf8");
      output = recorded === "deepseek" ? parseDeepSeekOutput(raw, manifest.station === "intent")
        : parseProviderOutput(recorded as RoleConfig["provider"], raw);
    }
    issues.push(...inspectReplayOutput(mode === "saved" && manifest.savedValidation
      ? { ...manifest, ...manifest.savedValidation } : manifest, output));
  } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  if (options.live) {
    try {
      sourceUnchanged = hash(JSON.stringify(inventory(cwd, "", separateGit))) === hash(JSON.stringify(manifest.files));
      if (separateGit) sourceUnchanged &&= hash(JSON.stringify(inventory(gitDirectory))) === gitIdentity &&
        hash(readFileSync(path.join(cwd, ".git"))) === gitLink;
    }
    catch { sourceUnchanged = false; }
    if (!sourceUnchanged) issues.push("Provider modified the isolated source; no candidate accepted.");
  }
  verifyReplayBundle(bundle);
  const result = {
    valid: issues.length === 0, qualityQualified: false as const, issues, live: !!options.live, mode,
    station: manifest.station, role: manifest.role, sourceUnchanged, durationMs: performance.now() - started,
    sourceAtCapture: manifest.sourceAtCapture, promptHash: hash(prompt), promptBytes: Buffer.byteLength(prompt),
    validationProvenance: mode === "saved" ? manifest.savedValidation?.provenance ?? "capture-time configuration" : "capture-time configuration",
    configurationHash: hash(JSON.stringify(config)), metrics,
    providerWorkMs: metrics.reduce((sum, value) => sum + value.durationMs, 0),
    usageComplete: metrics.length > 0 && metrics.every(value => value.tokens?.usageComplete),
    knownTotalTokens: metrics.reduce((sum, value) => sum + (value.tokens?.knownTotalTokens ?? 0), 0),
    scope: "Parser, station document and check-plan validation only. No approvals, runtime checks or semantic quality qualification.",
  };
  if (output !== undefined) writeFileSync(path.join(directory, "candidate.json"), JSON.stringify(output, null, 2));
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(result, null, 2));
  return result;
}
