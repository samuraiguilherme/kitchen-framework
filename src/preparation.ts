import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { hash, safePath } from "./domain.ts";
import { sourceFingerprint } from "./git.ts";
import { executeCheck } from "./checks.ts";
import { runProcess } from "./process.ts";
import type { CheckDefinition, Config, FeatureState } from "./types.ts";

export interface PreparationInput {
  reason: string;
  files: string[];
  setupProfiles: string[];
  checks: string[];
}
interface PreparationArtifact {
  runId: string;
  status: "passed" | "failed";
  reason: string;
  startedAt: string;
  finishedAt?: string;
  sourceFingerprint: string;
  sourceFingerprintAfter?: string;
  filesAfter?: Record<string, string | null>;
  baseCommit: string;
  documents: Record<string, { commit?: string; fingerprint?: string }>;
  profiles: Record<string, string>;
  files: Record<string, string>;
  environment: {
    platform: string;
    release: string;
    version: string;
    arch: string;
    node: string;
    executable: string;
  };
  evidenceHashes: Record<string, string>;
  error?: string;
}

// Operator-owned runtime preparation must never import feature implementations
// into the pinned RED baseline, even if they are in the accepted feature scope.
export function runtimeSupportPath(file: string): boolean {
  return (
    /^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json)$/.test(file) ||
    /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file) ||
    /^(?:apps|packages)\/[^/]+\/(?:vite|vitest)\.config\.[cm]?[jt]s$/.test(
      file,
    ) ||
    /^(?:apps|packages)\/[^/]+\/scripts\/(?:test-support\/[^/]+\.[cm]?[jt]s|[^/]+\.mjs)$/.test(
      file,
    )
  );
}

const documents = (state: FeatureState) =>
  Object.fromEntries(
    ["plan", "test-plan"].map((name) => {
      const record = state.stations[name as "plan" | "test-plan"];
      return [
        name,
        { commit: record?.commit, fingerprint: record?.approval?.fingerprint },
      ];
    }),
  );

export async function prepareRuntime(input: {
  root: string;
  state: FeatureState;
  config: Config;
  allowedPaths: string[];
  unitTestFiles: string[];
  checks: CheckDefinition[];
  request: PreparationInput;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<NonNullable<FeatureState["preparation"]>> {
  const { root, state, config, request } = input;
  if (
    !request ||
    typeof request.reason !== "string" ||
    !request.reason.trim() ||
    [request.files, request.setupProfiles, request.checks].some(
      (list) =>
        !Array.isArray(list) ||
        list.some((item) => typeof item !== "string") ||
        new Set(list).size !== list.length,
    ) ||
    !request.files.length ||
    !(request.setupProfiles.length + request.checks.length)
  )
    throw new Error(
      "Preparation requires a reason, exact unique files, setupProfiles and check IDs.",
    );
  for (const file of request.files) {
    safePath(state.worktree, file);
    if (
      !input.allowedPaths.includes(file) ||
      !runtimeSupportPath(file) ||
      input.unitTestFiles.includes(file)
    )
      throw new Error(
        `Preparation is limited to accepted runtime support, not feature code/tests: ${file}`,
      );
  }
  for (const id of request.setupProfiles)
    if (
      !input.checks.some((check) => check.profile === id) ||
      !config.profiles[id]?.setup
    )
      throw new Error(
        `Preparation setup must use an accepted profile with configured setup: ${id}`,
      );
  const checks = request.checks.map((id) => {
    const check = input.checks.find((candidate) => candidate.id === id);
    if (
      !check ||
      check.expectation !== "green" ||
      config.profiles[check.profile]?.kind !== "command"
    )
      throw new Error(
        `Preparation checks must be accepted GREEN command checks: ${id}`,
      );
    return check;
  });
  const profileIds = [
    ...new Set([
      ...request.setupProfiles,
      ...checks.map((check) => check.profile),
    ]),
  ];
  const runId = randomUUID();
  const directory = path.join(
    root,
    ".kitchen",
    "features",
    state.feature,
    "preparation",
    runId,
  );
  mkdirSync(directory, { recursive: true });
  const files = Object.fromEntries(
    request.files.map((file) => {
      const content = readFileSync(safePath(state.worktree, file));
      const snapshot = safePath(directory, file);
      mkdirSync(path.dirname(snapshot), { recursive: true });
      writeFileSync(snapshot, content);
      return [file, hash(content)];
    }),
  );
  const artifact: PreparationArtifact = {
    runId,
    status: "failed",
    reason: request.reason,
    startedAt: new Date().toISOString(),
    sourceFingerprint: await sourceFingerprint(state.worktree, state.feature),
    baseCommit: state.baseCommit,
    documents: documents(state),
    files,
    profiles: Object.fromEntries(
      profileIds.map((id) => [id, hash(JSON.stringify(config.profiles[id]))]),
    ),
    environment: {
      platform: process.platform,
      release: os.release(),
      version: os.version(),
      arch: process.arch,
      node: process.version,
      executable: process.execPath,
    },
    evidenceHashes: {},
  };
  const evidence = (name: string, value: unknown) => {
    const file = path.join(directory, name);
    writeFileSync(file, JSON.stringify(value, null, 2));
    artifact.evidenceHashes[name] = hash(readFileSync(file));
  };
  try {
    const startedAt = new Date().toISOString();
    const identity = await runProcess({
      command: "pnpm",
      args: ["--version"],
      cwd: state.worktree,
      timeoutMs: 10000,
      signal: input.signal,
    });
    evidence("pnpm-identity.json", {
      ...identity,
      startedAt,
      finishedAt: new Date().toISOString(),
      command: "pnpm",
      args: ["--version"],
      cwd: state.worktree,
    });
    if (identity.code !== 0)
      throw new Error("Could not establish pnpm identity.");
    for (const id of request.setupProfiles) {
      const profile = config.profiles[id]!;
      const cwd =
        profile.cwd && profile.cwd !== "."
          ? safePath(state.worktree, profile.cwd)
          : state.worktree;
      input.onProgress?.(`Preparation: ${id} dependency setup (${cwd})`);
      const startedAt = new Date().toISOString();
      const execution = await runProcess({
        ...profile.setup!,
        cwd,
        signal: input.signal,
        env: { ...profile.env, CI: "1" },
      });
      evidence(`setup-${id}.json`, {
        ...execution,
        startedAt,
        finishedAt: new Date().toISOString(),
        profile: id,
        cwd,
        ...profile.setup,
        sourceFingerprint: artifact.sourceFingerprint,
        files,
      });
      if (execution.code !== 0)
        throw new Error(
          `Preparation setup failed: ${id}. See raw evidence; infrastructure is not behavioral RED.`,
        );
    }
    for (const check of checks) {
      input.onProgress?.(`Preparation: ${check.id}`);
      const result = await executeCheck({
        definition: check,
        profile: config.profiles[check.profile]!,
        root: state.worktree,
        runDir: directory,
        fingerprint: artifact.sourceFingerprint,
        green: true,
        signal: input.signal,
      });
      for (const [file, sha256] of Object.entries(result.evidenceHashes ?? {}))
        artifact.evidenceHashes[path.basename(file)] = sha256;
      if (result.status !== "passed")
        throw new Error(
          `Preparation check failed: ${check.id}. See raw evidence.`,
        );
    }
    artifact.sourceFingerprintAfter = await sourceFingerprint(
      state.worktree,
      state.feature,
    );
    if (artifact.sourceFingerprintAfter !== artifact.sourceFingerprint)
      throw new Error(
        "Preparation commands changed source; inspect the diff and prepare again.",
      );
    artifact.status = "passed";
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
  }
  artifact.sourceFingerprintAfter ??= await sourceFingerprint(
    state.worktree,
    state.feature,
  );
  artifact.filesAfter = Object.fromEntries(
    request.files.map((file) => [
      file,
      existsSync(safePath(state.worktree, file))
        ? hash(readFileSync(safePath(state.worktree, file)))
        : null,
    ]),
  );
  artifact.finishedAt = new Date().toISOString();
  const file = path.join(directory, "preparation.json");
  writeFileSync(file, JSON.stringify(artifact, null, 2));
  return {
    runId,
    artifact: file,
    sha256: hash(readFileSync(file)),
    status: artifact.status,
  };
}

export function readPreparation(
  root: string,
  state: FeatureState,
  config: Config,
): PreparationArtifact | undefined {
  const record = state.preparation;
  if (!record) return;
  if (!/^[a-f0-9-]{36}$/.test(record.runId))
    throw new Error("Invalid preparation run ID.");
  const directory = path.join(
    root,
    ".kitchen",
    "features",
    state.feature,
    "preparation",
    record.runId,
  );
  const file = path.join(directory, "preparation.json");
  if (record.artifact !== file || hash(readFileSync(file)) !== record.sha256)
    throw new Error("Preparation artifact changed; rerun kitchen prepare.");
  const artifact: PreparationArtifact = JSON.parse(readFileSync(file, "utf8"));
  if (artifact.status !== "passed" || record.status !== "passed")
    throw new Error(`Runner preparation failed: ${artifact.error ?? file}`);
  if (
    artifact.baseCommit !== state.baseCommit ||
    JSON.stringify(artifact.documents) !== JSON.stringify(documents(state))
  )
    throw new Error(
      "Preparation document revisions changed; rerun kitchen prepare.",
    );
  for (const [id, sha256] of Object.entries(artifact.profiles))
    if (
      !config.profiles[id] ||
      hash(JSON.stringify(config.profiles[id])) !== sha256
    )
      throw new Error(
        `Preparation profile changed: ${id}. Rerun kitchen prepare.`,
      );
  for (const [name, sha256] of Object.entries(artifact.evidenceHashes))
    if (hash(readFileSync(safePath(directory, name))) !== sha256)
      throw new Error(
        `Preparation evidence changed: ${name}. Rerun kitchen prepare.`,
      );
  for (const [name, sha256] of Object.entries(artifact.files)) {
    if (
      !runtimeSupportPath(name) ||
      hash(readFileSync(safePath(state.worktree, name))) !== sha256 ||
      hash(readFileSync(safePath(directory, name))) !== sha256
    )
      throw new Error(
        `Prepared runtime source changed: ${name}. Rerun kitchen prepare.`,
      );
  }
  return artifact;
}

export function preparationContents(
  root: string,
  state: FeatureState,
  config: Config,
): Record<string, string> {
  const artifact = readPreparation(root, state, config);
  if (!artifact) return {};
  const directory = path.dirname(state.preparation!.artifact);
  return Object.fromEntries(
    Object.keys(artifact.files).map((file) => [
      file,
      readFileSync(safePath(directory, file), "utf8"),
    ]),
  );
}
