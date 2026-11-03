import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, targetPaths } from "../src/context.ts";
import { stationPrompt } from "../src/prompts.ts";
import type {
  AuthorOutput,
  FeatureState,
  StationRecord,
} from "../src/types.ts";

const roots: string[] = [];
const write = (root: string, file: string, content: string) => {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
};
const output = (document: string): AuthorOutput => ({
  summary: "Compact summary",
  questions: [],
  document,
  files: [
    {
      path: "apps/demo-web/src/sort.ts",
      action: "write",
      kind: "implementation",
      content: "FULL_PROPOSED_SOURCE_MUST_NOT_REPEAT",
    },
  ],
  allowedPaths: ["apps/demo-web/src/sort.ts"],
  unitTestFiles: [],
  scaffoldFiles: [],
  checks: [],
});
const record = (document: string): StationRecord => ({
  status: "approved",
  runId: "accepted-run",
  rubricVersion: "1.0.0",
  profileVersions: {},
  findings: [],
  checks: [],
  summary: "Compact summary",
  artifactFiles: [],
  output: output(document),
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-context-"));
  roots.push(root);
  for (const [file, content] of Object.entries({
    "AGENTS.md": "ROOT_REQUIRED_INSTRUCTION",
    "CLAUDE.md": "ROOT_CLAUDE_INSTRUCTION",
    "apps/demo-web/package.json": '{"name":"@example/demo-web"}',
    "apps/demo-web/AGENTS.md": "APP_REQUIRED_INSTRUCTION",
    "apps/demo-web/CLAUDE.md": "APP_CLAUDE_INSTRUCTION",
    "apps/demo-web/src/sort.ts": "export const order = 'original';\n",
    "kitchen.config.json": JSON.stringify({
      profiles: { observation: { kind: "manual" } },
    }),
  }))
    write(root, file, content);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Context Tests");
  git("config", "user.email", "context@example.test");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");
  const state: FeatureState = {
    version: 1,
    feature: "sort-items",
    request: "Add a column sort button in demo-web.",
    worktree: root,
    branch: "codex/kitchen/sort-items",
    baseCommit: git("rev-parse", "HEAD"),
    stations: {
      intent: record("STALE_INTENT_OUTPUT"),
      spec: record("STALE_SPEC_OUTPUT"),
      plan: record("STALE_PLAN_OUTPUT"),
    },
    conversation: [
      {
        role: "operator",
        station: "intent",
        text: "Sort only the selected column; keep other columns unchanged.",
        at: "TIMESTAMP_MUST_NOT_REPEAT",
      },
    ],
  };
  for (const name of ["intent", "spec", "plan", "test-plan"])
    write(
      root,
      `docs/features/${state.feature}/${name}.md`,
      `DOCUMENT_BODY_${name}\n`,
    );
  return {
    root,
    state,
    write: (file: string, content: string) => write(root, file, content),
  };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("station-specific context", () => {
  it("gives intent target instructions and an edited candidate without implementation context", async () => {
    const { root, state } = fixture();
    delete state.stations.plan;
    expect(targetPaths(state)).toContain("apps/demo-web/AGENTS.md");
    const context = await buildContext(state, "intent", root);
    for (const marker of [
      "ROOT_REQUIRED_INSTRUCTION",
      "ROOT_CLAUDE_INSTRUCTION",
      "APP_REQUIRED_INSTRUCTION",
      "APP_CLAUDE_INSTRUCTION",
      "DOCUMENT_BODY_intent",
    ])
      expect(context).toContain(marker);
    for (const marker of [
      "DOCUMENT_BODY_spec",
      "CHECK PROFILES",
      "LOCAL RUN STATE",
      "DIFF",
      "FULL_PROPOSED_SOURCE_MUST_NOT_REPEAT",
    ])
      expect(context).not.toContain(marker);
    const prompt = stationPrompt(state, "intent", "author", context);
    expect(prompt).toContain(state.conversation[0]!.text);
    expect(prompt).toContain('"role":"operator"');
    expect(prompt).not.toContain("TIMESTAMP_MUST_NOT_REPEAT");
    expect(prompt).toContain("Capture product intent only");
    expect(prompt).not.toContain("- implementation:");
    expect(prompt).not.toContain("- unit-tests:");
    expect(prompt).toContain("Fresh session. Read-only tools.");
  });

  it("keeps selected authoritative documents and compact evidence while excluding full proposals and document diffs", async () => {
    const { root, state, write: update } = fixture();
    state.stations.plan!.checks = [
      {
        id: "sort-unit",
        required: true,
        status: "passed",
        evidence: "raw-sort.json",
        evidenceHashes: { raw: "FULL_EVIDENCE_HASH_MUST_NOT_REPEAT" },
      },
    ];
    const featurePlan = `docs/features/${state.feature}/plan.md`;
    execFileSync("git", ["add", "docs"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["commit", "--quiet", "-m", "documents"], {
      cwd: root,
      stdio: "pipe",
    });
    update(featurePlan, "OPERATOR_EDITED_PLAN_BODY\n");
    update(
      "apps/demo-web/src/sort.ts",
      "export const order = 'SOURCE_CHANGE';\n",
    );
    const context = await buildContext(state, "plan", root);
    expect(context).toContain("DOCUMENT_BODY_intent");
    expect(context).toContain("DOCUMENT_BODY_spec");
    expect(context).toContain("OPERATOR_EDITED_PLAN_BODY");
    expect(context.match(/OPERATOR_EDITED_PLAN_BODY/g)).toHaveLength(1);
    expect(context).not.toContain("DOCUMENT_BODY_test-plan");
    expect(context).not.toContain("STALE_PLAN_OUTPUT");
    expect(context).not.toContain("FULL_PROPOSED_SOURCE_MUST_NOT_REPEAT");
    expect(context).not.toContain("FULL_EVIDENCE_HASH_MUST_NOT_REPEAT");
    expect(context).toContain('"evidence":"raw-sort.json"');
    const diff = context
      .split("DIFF (source only; documents appear above):\n")[1]!
      .split("UNTRACKED FILES:")[0]!;
    expect(diff).toContain("SOURCE_CHANGE");
    expect(diff).not.toContain(featurePlan);
    expect(diff).not.toContain("DOCUMENT_BODY_");
    const prompt = stationPrompt(state, "plan", "author", context);
    expect(prompt).toContain(
      "- plan: list exact repository-relative allowedPaths",
    );
    expect(prompt).not.toContain("- unit-tests:");
  });

  it("keeps implementation contracts and runtime evidence without unrelated station rules", async () => {
    const { root, state } = fixture();
    const context = await buildContext(state, "implementation", root);
    for (const name of ["spec", "plan", "test-plan"])
      expect(context).toContain(`DOCUMENT_BODY_${name}`);
    expect(context).not.toContain("DOCUMENT_BODY_intent");
    expect(context).toContain("RUNNER PREPARATION");
    expect(context).toContain("not prepared");
    expect(context).toContain("CHECK PROFILES");
    const prompt = stationPrompt(
      state,
      "implementation",
      "author",
      context,
      "Preserve AC-1.",
    );
    expect(prompt).toContain("Never rewrite/delete approved unit tests");
    expect(prompt).toContain("Preserve AC-1.");
    expect(prompt).not.toContain("- test-plan:");
    expect(prompt).not.toContain("- publish:");
  });
});
