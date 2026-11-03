import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { instructions } from "./prompts.ts";
import { git } from "./git.ts";
import { loadConfig } from "./config.ts";
import { readPreparation } from "./preparation.ts";
import { safePath } from "./domain.ts";
import type { FeatureState, Station } from "./types.ts";

export function targetPaths(
  state: FeatureState,
  includePlanScope = true,
): string[] {
  if (includePlanScope && state.stations.plan?.output?.allowedPaths.length)
    return state.stations.plan.output.allowedPaths;
  const explicit = [
    ...state.request.matchAll(/\b(?:apps|packages)\/[a-z0-9-]+\b/g),
  ].map((match) => match[0]);
  for (const name of state.request.match(
    /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g,
  ) ?? [])
    for (const kind of ["apps", "packages"])
      if (existsSync(path.join(state.worktree, kind, name, "package.json")))
        explicit.push(`${kind}/${name}`);
  return [...new Set(explicit)].map((directory) => `${directory}/AGENTS.md`);
}

export async function buildContext(
  state: FeatureState,
  station: Station,
  configRoot: string,
  compact = false,
): Promise<string> {
  const config = loadConfig(configRoot);
  const selected: Record<Station, string[]> = {
    intent: [],
    spec: ["intent"],
    plan: ["intent", "spec"],
    "test-plan": ["intent", "spec", "plan"],
    "unit-tests": ["spec", "plan", "test-plan"],
    implementation: ["spec", "plan", "test-plan"],
    verify: ["intent", "spec", "plan", "test-plan"],
    publish: ["intent", "spec", "plan", "test-plan", "verification"],
  };
  // A rerun needs the operator-edited candidate, without repeating it in state/diff.
  if (["intent", "spec", "plan", "test-plan"].includes(station))
    selected[station].push(station);
  const sections = [
    instructions(
      state.worktree,
      targetPaths(state, !["intent", "spec"].includes(station)),
    ),
  ];
  for (const name of selected[station]) {
    const file = `docs/features/${state.feature}/${name}.md`;
    const absolute = safePath(state.worktree, file);
    if (existsSync(absolute))
      sections.push(`DOCUMENT ${file}\n${readFileSync(absolute, "utf8")}`);
  }
  if (station === "intent") return sections.join("\n\n");
  const execution = ["unit-tests", "implementation", "verify", "publish"].includes(station);
  const relevant = new Set([
    ...selected[station], station,
    ...(execution ? ["unit-tests", "implementation"] : []),
  ]);
  const records = Object.entries(state.stations).filter(([name, record]) =>
    !compact || relevant.has(name) ||
    record?.findings.some((finding) => finding.blocking) ||
    record?.output?.questions.length || record?.checks.length,
  );
  sections.push(
    `LOCAL RUN STATE (full outputs/evidence remain in runner artifacts):\n${JSON.stringify(
      Object.fromEntries(
        records.map(([name, record]) => [
          name,
          {
            status: record?.status,
            runId: record?.runId,
            commit: record?.commit,
            summary: !compact || relevant.has(name) ? record?.summary : undefined,
            findings: record?.findings,
            artifactFiles: record?.artifactFiles,
            questions: record?.output?.questions,
            checks: record?.checks.map(
              ({ evidenceHashes: _hashes, ...check }) => check,
            ),
          },
        ]),
      ),
    )}`,
  );
  const profileIds = new Set(Object.values(state.stations).flatMap(
    (record) => record?.output?.checks.map((check) => check.profile) ?? [],
  ));
  const profiles = compact && execution && profileIds.size
    ? Object.fromEntries(Object.entries(config.profiles).filter(
        ([id]) => profileIds.has(id),
      ))
    : config.profiles;
  if (station !== "spec")
    sections.push(
      `CHECK PROFILES (human-controlled):\n${JSON.stringify(profiles)}`,
    );
  if (["unit-tests", "implementation", "verify", "publish"].includes(station))
    sections.push(
      `RUNNER PREPARATION (operator-owned runtime support, not minimal scaffolds):\n${JSON.stringify(readPreparation(configRoot, state, config) ?? null)}\nArtifact: ${state.preparation?.artifact ?? "not prepared"}`,
    );
  sections.push(
    `BASELINE: ${state.baseCommit}; TESTS-FIRST COMMIT: ${state.testsFirstCommit ?? "not yet recorded"}`,
  );
  if (station !== "spec") {
    sections.push(
      `DIFF (source only; documents appear above):\n${await git(state.worktree, "diff", state.baseCommit, "--", ".", ":!.kitchen", `:!docs/features/${state.feature}`)}`,
    );
    sections.push(
      `UNTRACKED FILES:\n${await git(state.worktree, "ls-files", "--others", "--exclude-standard")}`,
    );
  }
  return sections.join("\n\n");
}
