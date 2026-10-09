import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import {
  acceptanceIds,
  digest,
  gateReady,
  hash,
  lintDocument,
  requireAwaitingApproval,
  rubricVersion,
  safePath,
  stationOrder,
  validateFeature,
} from "./domain.ts";
import { loadConfig } from "./config.ts";
import { executeCheck, validateCheckPlan } from "./checks.ts";
import {
  baselineWorktree,
  commitFiles,
  createWorktree,
  git,
  sourceFiles,
  sourceFingerprint,
} from "./git.ts";
import { GitHub } from "./github.ts";
import {
  hostedProvider,
  validateAuthorOutput,
  validateReviewOutput,
} from "./providers.ts";
import { instructions, rubric, stationPrompt } from "./prompts.ts";
import { Storage } from "./storage.ts";
import { execute } from "./process.ts";
import type {
  AuthorOutput,
  FeatureState,
  FileChange,
  GitHubGateway,
  ManualObservation,
  Provider,
  Station,
  StationRecord,
} from "./types.ts";

const docs = ["intent", "spec", "plan", "test-plan"];
const now = () => new Date().toISOString();
const blank: AuthorOutput = {
  summary: "",
  questions: [],
  document: null,
  files: [],
  allowedPaths: [],
  unitTestFiles: [],
  scaffoldFiles: [],
  checks: [],
};
const manifestHeading = "\n## Kitchen execution manifest\n";
interface RunOptions {
  ask?: (question: string) => Promise<string>;
  feedback?: string;
  signal?: AbortSignal;
  observations?: ManualObservation[];
  onProgress?: (message: string) => void;
}
interface ApproveOptions {
  actor: string;
  resolutions?: Record<string, string>;
  reviewMinutes?: number;
}
export class Kitchen {
  readonly root: string;
  private readonly storage: Storage;
  private readonly provider: Provider;
  private readonly github: GitHubGateway;
  private readonly allowFixtureRemote: boolean;
  constructor(options: {
    root: string;
    provider?: Provider;
    github?: GitHubGateway;
  }) {
    this.root = path.resolve(options.root);
    this.storage = new Storage(this.root);
    this.provider = options.provider ?? hostedProvider;
    this.github = options.github ?? new GitHub();
    this.allowFixtureRemote = Boolean(options.github);
  }
  private document(state: FeatureState, name: string): string {
    return `docs/features/${state.feature}/${name}.md`;
  }
  private readDocument(state: FeatureState, name: string): string {
    const file = safePath(state.worktree, this.document(state, name));
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  private manifest(
    state: FeatureState,
    station: "plan" | "test-plan",
  ): AuthorOutput {
    const document = this.readDocument(state, station);
    const section = document.split(manifestHeading)[1];
    if (!section)
      throw new Error(
        `${station} has no execution manifest. Rerun and review the station.`,
      );
    const raw = section.match(/^```json\r?\n([^]*?)\r?\n```/);
    if (!raw) throw new Error(`Invalid ${station} execution manifest.`);
    const value = JSON.parse(raw[1]!);
    return validateAuthorOutput({ ...blank, ...value });
  }
  private contracts(state: FeatureState) {
    const plan = this.manifest(state, "plan");
    const testPlan = this.manifest(state, "test-plan");
    return {
      allowedPaths: plan.allowedPaths,
      unitTestFiles: testPlan.unitTestFiles,
      scaffoldFiles: testPlan.scaffoldFiles,
      checks: testPlan.checks,
    };
  }
  private async fingerprint(
    state: FeatureState,
    station: Station,
  ): Promise<string> {
    const index = stationOrder.indexOf(station);
    const upstream = stationOrder.slice(0, index).map((s) => ({
      station: s,
      fingerprint: state.stations[s]?.approval?.fingerprint,
      status: state.stations[s]?.status,
    }));
    const record = state.stations[station];
    const artifact = digest(state.worktree, record?.artifactFiles ?? []);
    const source = ["implementation", "verify", "publish"].includes(station)
      ? await sourceFingerprint(state.worktree, state.feature)
      : null;
    const config = loadConfig(this.root);
    const stationConfig = config.stations[station];
    const policy = {
      base: config.base,
      provider: {
        author:
          station === "publish"
            ? undefined
            : (stationConfig?.author ?? config.providers.author),
        reviewEnabled: stationConfig?.reviewEnabled === true,
        review: stationConfig?.reviewEnabled
          ? (stationConfig.review ?? config.providers.review)
          : undefined,
        timeoutMs: config.providers.timeoutMs,
      },
      profiles: [
        "test-plan",
        "unit-tests",
        "implementation",
        "verify",
        "publish",
      ].includes(station)
        ? config.profiles
        : undefined,
      github: station === "publish" ? config.github : undefined,
    };
    const evidence = record?.checks.flatMap((check) =>
      Object.keys(check.evidenceHashes ?? {})
        .sort()
        .map((file) => [
          file,
          existsSync(file) ? hash(readFileSync(file)) : null,
        ]),
    );
    return hash(
      JSON.stringify({
        station,
        upstream,
        artifact,
        source,
        base: state.baseCommit,
        policy,
        rubric: rubric(station),
        instructions: instructions(
          state.worktree,
          index >= 2 ? state.stations.plan?.output?.allowedPaths : [],
        ),
        output: record?.output,
        findings: record?.findings,
        summary: record?.summary,
        checks: record?.checks,
        versions: [record?.rubricVersion, record?.profileVersions],
        evidence,
        scaffolds: station === "unit-tests" ? state.scaffoldContents : null,
        preview: station === "publish" ? this.previewBody(state) : null,
      }),
    );
  }
  private async refresh(state: FeatureState): Promise<FeatureState> {
    let stale = false;
    for (const station of stationOrder) {
      const record = state.stations[station];
      if (!record) continue;
      if (
        record.status === "approved" &&
        (stale ||
          record.approval?.fingerprint !==
            (await this.fingerprint(state, station)))
      ) {
        record.status = "stale";
        stale = true;
      } else if (record.status === "stale") stale = true;
      else if (stale && record.status === "awaiting-approval")
        record.status = "stale";
    }
    return state;
  }
  async status(feature: string): Promise<FeatureState> {
    return this.refresh(this.storage.read(validateFeature(feature)));
  }
  async start(
    feature: string,
    options: { request: string; issue?: string },
  ): Promise<FeatureState> {
    validateFeature(feature);
    if (!options.request.trim())
      throw new Error("A human feature request is required.");
    if (
      options.issue &&
      !/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(options.issue)
    )
      throw new Error("Issue must be a GitHub issue URL.");
    return this.storage.lock(feature, async () => {
      if (existsSync(this.storage.file(feature))) return this.status(feature);
      const config = loadConfig(this.root);
      const baseCommit = await git(
        this.root,
        "rev-parse",
        "--verify",
        `${config.base}^{commit}`,
      );
      if (
        (await git(this.root, "check-ignore", ".kitchen/probe")).trim() !==
        ".kitchen/probe"
      )
        throw new Error(".kitchen/ must be Git-ignored before starting.");
      const worktree = await createWorktree(this.root, feature, baseCommit);
      const state: FeatureState = {
        version: 1,
        feature,
        request: options.request,
        issue: options.issue,
        baseCommit,
        ...worktree,
        stations: {},
        conversation: [
          {
            role: "operator",
            station: "intent",
            text: options.request,
            at: now(),
          },
        ],
      };
      this.storage.save(state);
      return state;
    });
  }
  private requirePrevious(state: FeatureState, station: Station): void {
    for (const previous of stationOrder.slice(0, stationOrder.indexOf(station)))
      if (state.stations[previous]?.status !== "approved")
        throw new Error(
          `Approve ${previous} before ${station} (it may be stale).`,
        );
    if (
      ["implementation", "verify", "publish"].includes(station) &&
      !state.testsFirstCommit
    )
      throw new Error(
        "Accepted unit-tests and a tests-first commit are required.",
      );
  }
  private async context(state: FeatureState): Promise<string> {
    const config = loadConfig(this.root);
    return [
      instructions(state.worktree, state.stations.plan?.output?.allowedPaths),
      ...docs.map(
        (s) =>
          `DOCUMENT ${this.document(state, s)}\n${this.readDocument(state, s)}`,
      ),
      `CHECK PROFILES (human-controlled):\n${JSON.stringify(config.profiles)}`,
      `LOCAL RUN STATE AND EXECUTABLE EVIDENCE:\n${JSON.stringify(state.stations)}`,
      `BASELINE: ${state.baseCommit}; TESTS-FIRST COMMIT: ${state.testsFirstCommit ?? "not yet recorded"}`,
      `DIFF:\n${await git(state.worktree, "diff", state.baseCommit, "--", ".", ":!.kitchen")}`,
      `UNTRACKED FILES:\n${await git(state.worktree, "ls-files", "--others", "--exclude-standard")}`,
    ].join("\n\n");
  }
  private record(): StationRecord {
    const config = loadConfig(this.root);
    return {
      status: "running",
      runId: randomUUID(),
      rubricVersion,
      profileVersions: Object.fromEntries(
        Object.entries(config.profiles).map(([id, p]) => [
          id,
          `${p.version ?? "unversioned"}:${hash(JSON.stringify(p))}`,
        ]),
      ),
      findings: [],
      checks: [],
      summary: "",
      artifactFiles: [],
    };
  }
  private async callProvider(
    state: FeatureState,
    station: Station,
    role: "author" | "review",
    runDir: string,
    options: RunOptions,
    suffix = "",
  ): Promise<unknown> {
    if (options.signal?.aborted) throw new Error("Station cancelled.");
    const config = loadConfig(this.root);
    const context = await this.context(state);
    const before = await sourceFingerprint(state.worktree, state.feature);
    const artifacts = digest(
      state.worktree,
      state.stations[station]?.artifactFiles ?? [],
    );
    const output = await this.provider({
      station,
      role,
      prompt: stationPrompt(
        state,
        station,
        role,
        context,
        options.feedback,
        config.stations[station]?.reviewEnabled,
      ),
      cwd: state.worktree,
      runDir: path.join(runDir, role + suffix),
      config: config.stations[station]?.[role] ?? config.providers[role],
      timeoutMs: config.providers.timeoutMs,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    if (options.signal?.aborted) throw new Error("Station cancelled.");
    if (
      (await sourceFingerprint(state.worktree, state.feature)) !== before ||
      digest(state.worktree, state.stations[station]?.artifactFiles ?? []) !==
        artifacts
    )
      throw new Error(
        "Provider changed repository contents outside the runner.",
      );
    mkdirSync(path.join(runDir, role + suffix), { recursive: true });
    writeFileSync(
      path.join(runDir, role + suffix, "validated-output.json"),
      JSON.stringify(output, null, 2),
    );
    return output;
  }
  private invalidateAfter(state: FeatureState, station: Station): void {
    for (const next of stationOrder.slice(stationOrder.indexOf(station) + 1))
      if (state.stations[next]) state.stations[next]!.status = "stale";
  }
  async run(
    feature: string,
    station: Station,
    options: RunOptions = {},
  ): Promise<FeatureState> {
    if (!stationOrder.includes(station) || station === "publish")
      throw new Error("Use publish --preview for the publish station.");
    return this.storage.lock(feature, async () => {
      const state = await this.status(feature);
      this.requirePrevious(state, station);
      if (state.pr)
        throw new Error(
          "Feature already published. Use a new feature for subsequent work.",
        );
      if (
        station === "unit-tests" &&
        state.testsFirstCommit &&
        !/AC-\d+/.test(options.feedback ?? "")
      )
        throw new Error(
          "Revising accepted tests requires a human explanation referencing the affected AC-n requirement.",
        );
      const pending = state.stations[station];
      if (
        pending?.status === "awaiting-input" &&
        pending.output &&
        pending.output.questions.length &&
        !options.feedback?.trim()
      ) {
        if (!options.ask) return state;
        const pendingOutput = pending.output;
        for (const [index, question] of pendingOutput.questions.entries()) {
          if (options.signal?.aborted) throw new Error("Station cancelled.");
          const answer = await options.ask(question.text);
          if (!answer.trim())
            throw new Error("A guided question was left unanswered.");
          state.conversation.push({
            role: "operator",
            station,
            text: answer,
            at: now(),
          });
          pending.output = {
            ...pendingOutput,
            questions: pendingOutput.questions.slice(index + 1),
          };
          this.storage.save(state);
        }
      }
      if (options.feedback?.trim())
        state.conversation.push({
          role: "operator",
          station,
          text: options.feedback,
          at: now(),
        });
      this.invalidateAfter(state, station);
      const record = this.record();
      state.stations[station] = record;
      this.storage.save(state);
      const runDir = path.join(
        this.storage.directory(feature),
        "runs",
        record.runId,
      );
      mkdirSync(runDir, { recursive: true });
      const config = loadConfig(this.root);
      const call = (role: "author" | "review", suffix = "") =>
        this.callProvider(state, station, role, runDir, options, suffix);
      try {
        let output = validateAuthorOutput(await call("author"));
        if (output.questions.length) {
          // Questions take precedence over bundled proposals. Only a fresh
          // response without questions may reach applyOutput and review.
          for (const question of output.questions) {
            state.conversation.push({
              role: "model",
              station,
              text: question.text,
              at: now(),
            });
            if (options.ask) {
              const answer = await options.ask(question.text);
              if (!answer.trim())
                throw new Error("A guided question was left unanswered.");
              state.conversation.push({
                role: "operator",
                station,
                text: answer,
                at: now(),
              });
            }
          }
          this.storage.save(state);
          if (!options.ask) {
            record.status = "awaiting-input";
            record.output = output;
            this.storage.save(state);
            return state;
          }
          output = validateAuthorOutput(await call("author", "-after-answers"));
          if (output.questions.length) {
            for (const q of output.questions)
              state.conversation.push({
                role: "model",
                station,
                text: q.text,
                at: now(),
              });
            record.status = "awaiting-input";
            record.output = output;
            this.storage.save(state);
            return state;
          }
        }
        record.output = output;
        record.summary = output.summary;
        await this.applyOutput(state, station, output, record);
        if (station === "unit-tests") {
          await this.unitChecks(state, record, runDir, options);
        } else if (station === "implementation" || station === "verify") {
          const before = await sourceFingerprint(state.worktree, feature);
          for (const check of this.contracts(state).checks) {
            const profile = config.profiles[check.profile]!;
            record.checks.push(
              await executeCheck({
                definition: check,
                profile,
                root: state.worktree,
                runDir,
                fingerprint: before,
                green: true,
                signal: options.signal,
                observations: options.observations,
              }),
            );
          }
          if ((await sourceFingerprint(state.worktree, feature)) !== before)
            throw new Error(
              "Checks changed candidate source; review the diff and rerun.",
            );
        }
        if (station === "verify") {
          record.artifactFiles = [this.document(state, "verification")];
          writeFileSync(
            safePath(state.worktree, record.artifactFiles[0]!),
            await this.renderReport(state),
          );
        }
        if (config.stations[station]?.reviewEnabled) {
          const review = validateReviewOutput(await call("review"));
          record.summary += "\nIndependent review: " + review.summary;
          record.findings.push(...review.findings);
        }
        if (station === "verify")
          writeFileSync(
            safePath(state.worktree, this.document(state, "verification")),
            await this.renderReport(state),
          );
        record.status = "awaiting-approval";
        record.reviewFingerprint = await this.fingerprint(state, station);
        this.storage.save(state);
        return state;
      } catch (error) {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        this.storage.save(state);
        throw error;
      }
    });
  }
  private async applyOutput(
    state: FeatureState,
    station: Station,
    output: AuthorOutput,
    record: StationRecord,
  ): Promise<void> {
    if (docs.includes(station)) {
      if (!output.document || output.files.length)
        throw new Error(
          "Document stations require one document and no source changes.",
        );
      let document = output.document.split(manifestHeading)[0]!;
      if (station === "plan") {
        if (!output.allowedPaths.length)
          throw new Error("Plan requires explicit file scope.");
        for (const file of output.allowedPaths) safePath(state.worktree, file);
        document +=
          manifestHeading +
          "```json\n" +
          JSON.stringify({ allowedPaths: output.allowedPaths }, null, 2) +
          "\n```\n";
      }
      if (station === "test-plan") {
        const paths = this.manifest(state, "plan").allowedPaths;
        for (const file of [
          ...output.unitTestFiles,
          ...output.scaffoldFiles,
          ...output.checks.flatMap((c) => c.files),
        ]) {
          safePath(state.worktree, file);
          if (!paths.includes(file))
            throw new Error(`Test plan file outside accepted plan: ${file}`);
        }
        if (
          !output.unitTestFiles.length ||
          output.unitTestFiles.some((f) => output.scaffoldFiles.includes(f))
        )
          throw new Error(
            "Distinct unit test and scaffold files are required.",
          );
        if (
          output.unitTestFiles.some(
            (file) => !/(?:[.-](?:test|spec)|_test)\.[cm]?[jt]sx?$/.test(file),
          )
        )
          throw new Error(
            "Unit test manifest must name test/spec files, not production modules.",
          );
        record.findings.push(
          ...validateCheckPlan(
            acceptanceIds(this.readDocument(state, "spec")),
            output.checks,
            loadConfig(this.root).profiles,
          ),
        );
        document +=
          manifestHeading +
          "```json\n" +
          JSON.stringify(
            {
              unitTestFiles: output.unitTestFiles,
              scaffoldFiles: output.scaffoldFiles,
              checks: output.checks,
            },
            null,
            2,
          ) +
          "\n```\n";
      }
      record.findings.push(...lintDocument(station, document));
      const file = this.document(state, station);
      const target = safePath(state.worktree, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, document);
      record.artifactFiles = [file];
      return;
    }
    if (output.document)
      throw new Error(
        "Code/review stations cannot replace accepted documents.",
      );
    if (station === "verify" && output.files.length)
      throw new Error("Verification cannot modify candidate code.");
    const contract = this.contracts(state);
    const changes = output.files;
    if (new Set(changes.map((f) => f.path)).size !== changes.length)
      throw new Error("Duplicate output file proposals.");
    // Validate the complete proposal before applying any file.
    for (const change of changes) {
      safePath(state.worktree, change.path);
      if (!contract.allowedPaths.includes(change.path))
        throw new Error(`Change outside accepted plan: ${change.path}`);
      if (
        [...docs, "verification"].some(
          (name) => change.path === this.document(state, name),
        )
      )
        throw new Error(
          "Code stations cannot rewrite accepted feature documents. Return to their document station.",
        );
      if (change.action === "write" && change.content === null)
        throw new Error("Write requires content.");
      if (station === "unit-tests") {
        const test =
          contract.unitTestFiles.includes(change.path) &&
          change.kind === "test";
        const scaffold =
          contract.scaffoldFiles.includes(change.path) &&
          change.kind === "scaffold";
        if (!test && !scaffold)
          throw new Error(
            "Unit-tests station may only change approved tests or minimal scaffolds.",
          );
        if (change.action === "delete")
          throw new Error(
            "Tests-first checkpoint cannot delete its test or interface files.",
          );
        if (scaffold) {
          this.validateScaffold(change);
          const baseFiles = (
            await git(
              state.worktree,
              "ls-tree",
              "--name-only",
              state.baseCommit,
              "--",
              change.path,
            )
          ).trim();
          if (baseFiles)
            throw new Error(
              "Minimal scaffolds are only permitted for new interfaces, not existing production modules.",
            );
        }
      }
      if (
        station === "implementation" &&
        (contract.unitTestFiles.includes(change.path) ||
          (change.kind === "test" &&
            !contract.checks.some(
              (c) =>
                loadConfig(this.root).profiles[c.profile]?.kind !== "unit" &&
                c.files.includes(change.path),
            )))
      )
        throw new Error(
          "Approved tests cannot be rewritten by implementation. Return to unit-tests with a requirement-based explanation.",
        );
    }
    for (const change of changes) {
      const file = safePath(state.worktree, change.path);
      if (change.action === "delete") {
        if (existsSync(file)) unlinkSync(file);
      } else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, change.content!);
      }
      if (station === "unit-tests" && change.kind === "scaffold")
        state.scaffoldContents = {
          ...state.scaffoldContents,
          [change.path]: change.content!,
        };
    }
    if (station === "unit-tests") {
      // Scaffold proposals remain in the reviewed output/baseline snapshot; their bodies are implemented later.
      record.artifactFiles = contract.unitTestFiles;
      if (
        contract.unitTestFiles.some(
          (f) => !existsSync(safePath(state.worktree, f)),
        )
      )
        throw new Error("All approved unit tests must be implemented.");
    }
    if (station === "implementation")
      record.artifactFiles = contract.allowedPaths;
  }
  private validateScaffold(change: FileChange): void {
    const source = ts.createSourceFile(
      change.path,
      change.content!,
      ts.ScriptTarget.Latest,
      true,
    );
    let invalid = false;
    const visit = (node: ts.Node) => {
      const isUndefined = (expression: ts.Expression): boolean =>
        (ts.isIdentifier(expression) && expression.text === "undefined") ||
        ((ts.isAsExpression(expression) ||
          ts.isTypeAssertionExpression(expression)) &&
          isUndefined(expression.expression));
      if (
        ts.isBlock(node) &&
        (node.statements.length !== 1 ||
          !(
            ts.isThrowStatement(node.statements[0]!) ||
            (ts.isReturnStatement(node.statements[0]!) &&
              node.statements[0]!.expression &&
              isUndefined(node.statements[0]!.expression!))
          ))
      )
        invalid = true;
      if (ts.isVariableDeclaration(node) && node.initializer) invalid = true;
      if (ts.isCallExpression(node) || ts.isExportAssignment(node))
        invalid = true;
      if (
        ts.isNewExpression(node) &&
        !(
          ts.isIdentifier(node.expression) &&
          node.expression.text === "Error" &&
          (node.arguments ?? []).every((a) => ts.isStringLiteral(a))
        )
      )
        invalid = true;
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) invalid = true;
      if (
        ts.isExpressionStatement(node) ||
        ts.isIfStatement(node) ||
        (ts.isPropertyDeclaration(node) && node.initializer)
      )
        invalid = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (invalid)
      throw new Error(
        "Minimal interface scaffolds may contain only signatures/types, throw-only bodies or return undefined.",
      );
  }
  private async unitChecks(
    state: FeatureState,
    record: StationRecord,
    runDir: string,
    options: RunOptions,
  ): Promise<void> {
    const contract = this.contracts(state);
    const config = loadConfig(this.root);
    const target = path.join(
      this.root,
      ".kitchen",
      "baselines",
      state.feature + "-" + record.runId,
    );
    mkdirSync(path.dirname(target), { recursive: true });
    if (contract.scaffoldFiles.some((file) => !state.scaffoldContents?.[file]))
      throw new Error(
        "Every approved scaffold needs an independently reviewed minimal proposal.",
      );
    await baselineWorktree(
      this.root,
      state.baseCommit,
      target,
      state.worktree,
      [...contract.unitTestFiles, ...contract.scaffoldFiles],
      state.scaffoldContents,
    );
    const candidate = await sourceFingerprint(state.worktree, state.feature);
    const baseline = await sourceFingerprint(target, state.feature);
    try {
      for (const check of contract.checks.filter(
        (c) => config.profiles[c.profile]?.kind === "unit",
      )) {
        if (check.files.some((f) => !contract.unitTestFiles.includes(f)))
          throw new Error("Unit checks must execute accepted unit test files.");
        const result = await executeCheck({
          definition: check,
          profile: config.profiles[check.profile]!,
          root: target,
          runDir,
          fingerprint: candidate,
          green: false,
          signal: options.signal,
        });
        record.checks.push(result);
      }
      if (!record.checks.length) throw new Error("No unit test evidence.");
      if (
        (await sourceFingerprint(target, state.feature)) !== baseline ||
        (await sourceFingerprint(state.worktree, state.feature)) !== candidate
      )
        throw new Error("Unit check mutated candidate or baseline source.");
    } finally {
      // Keep detached baseline and raw evidence for diagnosis/recovery. No force cleanup.
      writeFileSync(
        path.join(runDir, "baseline.json"),
        JSON.stringify(
          {
            path: target,
            commit: state.baseCommit,
            fingerprint: baseline,
            candidate,
          },
          null,
          2,
        ),
      );
    }
  }
  async approve(
    feature: string,
    station: Station,
    options: ApproveOptions,
  ): Promise<FeatureState> {
    return this.storage.lock(feature, async () => {
      const state = await this.status(feature);
      this.requirePrevious(state, station);
      const record = requireAwaitingApproval(state, station);
      if (!options.actor.trim())
        throw new Error("Explicit human approver required.");
      const fingerprint = await this.fingerprint(state, station);
      if (record.reviewFingerprint !== fingerprint)
        throw new Error(
          "Artifact or inputs changed since validation. Rerun the station before approval.",
        );
      const resolutions = options.resolutions ?? {};
      for (const id of Object.keys(resolutions))
        if (!record.findings.some((f) => f.id === id))
          throw new Error(`Unknown finding resolution ${id}`);
      if (!gateReady(record.findings, record.checks, resolutions))
        throw new Error(
          "Unresolved blocking findings, required failures, or missing evidence prevent approval.",
        );
      if (
        station !== "unit-tests" &&
        record.checks.some((c) => c.status === "expected-red")
      )
        throw new Error("RED never counts as passing final verification.");
      if (station === "test-plan") {
        const contract = this.contracts(state);
        if (
          validateCheckPlan(
            acceptanceIds(this.readDocument(state, "spec")),
            contract.checks,
            loadConfig(this.root).profiles,
          ).length
        )
          throw new Error("Invalid executable test plan cannot be waived.");
      }
      if (docs.includes(station))
        record.commit = await commitFiles(
          state.worktree,
          record.artifactFiles,
          `docs(${feature}): approve ${station}`,
        );
      if (station === "unit-tests") {
        const contract = this.contracts(state);
        const checkpoint = await commitFiles(
          state.worktree,
          [
            ...docs.map((s) => this.document(state, s)),
            ...contract.unitTestFiles,
            ...(!state.testsFirstCommit ? contract.scaffoldFiles : []),
          ],
          state.testsFirstCommit
            ? `test(${feature}): approved requirement-based test revision`
            : `test(${feature}): approved unit tests before feature implementation`,
        );
        if (state.testsFirstCommit)
          state.testRevisionCommits = [
            ...(state.testRevisionCommits ?? []),
            checkpoint,
          ];
        else state.testsFirstCommit = checkpoint;
        state.testHashes = Object.fromEntries(
          contract.unitTestFiles.map((f) => [f, digest(state.worktree, [f])]),
        );
      }
      record.approval = {
        actor: options.actor,
        at: now(),
        fingerprint,
        resolutions,
        reviewMinutes: options.reviewMinutes,
      };
      record.status = "approved";
      this.storage.save(state);
      return state;
    });
  }
  private async renderReport(state: FeatureState): Promise<string> {
    const fingerprint = await sourceFingerprint(state.worktree, state.feature);
    const ids = acceptanceIds(this.readDocument(state, "spec"));
    const lines = [
      `# Verification: ${state.feature}`,
      "",
      `Checked source fingerprint: \`${fingerprint}\``,
      `Pinned base: \`${state.baseCommit}\``,
      `Tests-first commit: \`${state.testsFirstCommit ?? "pending"}\``,
      `Rubric version: ${rubricVersion}`,
      "",
      `Acceptance criteria: ${ids.join(", ")}`,
      "",
      "## Executable evidence",
      "",
      "| Station | Check | Result | Executed | Failed | Criteria |",
      "|---|---|---|---:|---:|---|",
    ];
    for (const [station, record] of Object.entries(state.stations))
      for (const c of record!.checks)
        lines.push(
          `| ${station} | ${c.id} | ${c.status} | ${c.total ?? "N/A"} | ${c.failed ?? "N/A"} | ${c.acIds?.join(", ") ?? ""} |`,
        );
    lines.push(
      "",
      "Expected RED establishes the tests-first checkpoint; it is never passing final evidence.",
      "",
      "## LLM judgments",
      "",
    );
    for (const [station, record] of Object.entries(state.stations)) {
      lines.push(`### ${station}`, "", record!.summary);
      for (const f of record!.findings)
        lines.push(
          `- [${f.blocking ? "blocking" : "advisory"}] ${f.id} / ${f.rule}: ${f.evidence}. Consequence: ${f.consequence}. Resolution: ${f.resolution}.`,
        );
    }
    lines.push("", "## Human observations and decisions", "");
    for (const [station, record] of Object.entries(state.stations)) {
      if (record!.approval)
        lines.push(
          `- ${station}: accepted by ${record!.approval.actor} at ${record!.approval.at}. Disputed findings: ${JSON.stringify(record!.approval.resolutions)}.`,
        );
      for (const c of record!.checks)
        if (c.observation) lines.push(`- ${c.id}: ${c.observation}`);
    }
    lines.push(
      "",
      `Recorded human review effort: ${Object.values(state.stations).reduce((sum, r) => sum + (r?.approval?.reviewMinutes ?? 0), 0)} minutes.`,
      `Requirement-based test revision commits: ${state.testRevisionCommits?.join(", ") || "none"}.`,
      "",
      "## Limitations",
      "",
      "Author judgments and any opted-in independent reviews are not executable proof. Optional/unverified checks and missing manual observations remain visible. Local raw transcripts and evidence are retained under .kitchen; they are not included in this commit.",
      "",
    );
    return lines.join("\n");
  }
  async report(feature: string): Promise<string> {
    return this.renderReport(await this.status(feature));
  }
  private previewBody(state: FeatureState): { title: string; body: string } {
    const title = `feat: ${state.feature.replaceAll("-", " ")}`;
    const prefix = `docs/features/${state.feature}`;
    return {
      title,
      body: [
        state.request,
        "",
        state.issue ? `Related issue: ${state.issue}` : "",
        "## Feature documents",
        ...[...docs, "verification"].map(
          (s) => `- [${s}.md](${prefix}/${s}.md)`,
        ),
        "",
        `Tests-first checkpoint: ${state.testsFirstCommit}`,
        "",
        "## Verification",
        state.stations.verify?.summary ?? "",
        ...Object.values(state.stations).flatMap((r) =>
          r!.checks.map(
            (c) => `- ${c.id}: ${c.status}; ${c.total ?? "N/A"} executed.`,
          ),
        ),
        "",
        "Human-approved stations; draft for final code review. No merge or deployment performed.",
      ]
        .filter((s) => s !== undefined)
        .join("\n"),
    };
  }
  private async checkCandidate(
    state: FeatureState,
    remote: boolean,
  ): Promise<void> {
    const config = loadConfig(this.root);
    if (
      (await git(state.worktree, "branch", "--show-current")) !== state.branch
    )
      throw new Error("Candidate branch drift detected.");
    if ((await git(this.root, "rev-parse", config.base)) !== state.baseCommit)
      throw new Error(
        "Base drift detected. Reconcile the feature, then renew approvals and verification.",
      );
    await git(
      state.worktree,
      "merge-base",
      "--is-ancestor",
      state.testsFirstCommit!,
      "HEAD",
    );
    const changed = (
      await git(state.worktree, "diff", "--name-only", state.baseCommit, "-z")
    )
      .split("\0")
      .filter(Boolean);
    const untracked = (
      await git(
        state.worktree,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      )
    )
      .split("\0")
      .filter(Boolean);
    const allowed = [
      ...this.contracts(state).allowedPaths,
      ...[...docs, "verification"].map((s) => this.document(state, s)),
    ];
    if ([...changed, ...untracked].some((f) => !allowed.includes(f)))
      throw new Error("Candidate contains changes outside accepted scope.");
    for (const [file, expected] of Object.entries(state.testHashes ?? {}))
      if (digest(state.worktree, [file]) !== expected)
        throw new Error("Approved test integrity changed.");
    if (remote) {
      const remoteUrls = [
        ...new Set([
          ...(
            await git(this.root, "remote", "get-url", "--all", "origin")
          ).split(/\r?\n/),
          ...(
            await git(
              this.root,
              "remote",
              "get-url",
              "--push",
              "--all",
              "origin",
            )
          ).split(/\r?\n/),
        ]),
      ];
      for (const remoteUrl of remoteUrls) {
        const normalized = remoteUrl
          .replaceAll("\\", "/")
          .replace(/\.git$/, "");
        const repository = normalized.match(/(?:[:/])([^/]+\/[^/]+)$/)?.[1];
        if (
          !config.github.repository ||
          repository !== config.github.repository
        )
          throw new Error(
            "Configured GitHub repository does not match origin.",
          );
        if (!(this.allowFixtureRemote && existsSync(remoteUrl))) {
          let host: string | undefined;
          if (
            remoteUrl.startsWith("https://") ||
            remoteUrl.startsWith("ssh://")
          )
            host = new URL(remoteUrl).hostname;
          else host = remoteUrl.match(/^(?:[^@]+@)?([^:/]+):/)?.[1];
          if (!host) throw new Error("Origin must target GitHub.");
          if (host !== "github.com") {
            if (remoteUrl.startsWith("https://"))
              throw new Error(
                "Origin push/fetch destination must be github.com.",
              );
            const sshConfig = await execute("ssh", ["-G", host], this.root);
            if (!/^hostname github\.com\s*$/m.test(sshConfig))
              throw new Error(
                "Origin SSH alias does not resolve to github.com.",
              );
          }
        }
      }
      const remoteBase = (
        await git(this.root, "ls-remote", "origin", "refs/heads/develop")
      ).split(/\s/)[0];
      if (remoteBase !== state.baseCommit)
        throw new Error(
          "Remote develop changed. Fetch/reconcile and renew verification before publication.",
        );
    }
  }
  async publish(
    feature: string,
    options: { preview?: boolean } & Pick<
      RunOptions,
      "signal" | "onProgress"
    > = {},
  ): Promise<{
    title: string;
    body: string;
    diff?: string;
    url?: string;
    previewFile?: string;
  }> {
    return this.storage.lock(feature, async () => {
      const state = await this.status(feature);
      this.requirePrevious(state, "publish");
      if (!options.preview && state.pr)
        return { ...this.previewBody(state), url: state.pr };
      await this.checkCandidate(state, !options.preview);
      const preview = this.previewBody(state);
      const dir = this.storage.directory(feature);
      const bodyFile = path.join(dir, "pr-body.md");
      writeFileSync(bodyFile, preview.body);
      if (options.preview) {
        const record = this.record();
        record.summary = "Exact PR preview prepared; no remote writes.";
        record.artifactFiles = [...docs, "verification"].map((s) =>
          this.document(state, s),
        );
        state.stations.publish = record;
        this.storage.save(state);
        const diff = await git(state.worktree, "diff", state.baseCommit);
        const newFiles = (
          await git(
            state.worktree,
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
          )
        )
          .split("\0")
          .filter(Boolean);
        const untrackedDiff = newFiles
          .map(
            (file) =>
              `NEW FILE ${file}\n${readFileSync(safePath(state.worktree, file), "utf8")}`,
          )
          .join("\n");
        const previewFile = path.join(dir, "publication-preview.md");
        writeFileSync(
          previewFile,
          `# ${preview.title}\n\n${preview.body}\n\n## Exact candidate changes\n\n${diff}\n${untrackedDiff}\n`,
        );
        try {
          const config = loadConfig(this.root);
          if (config.stations.publish?.reviewEnabled) {
            const review = validateReviewOutput(
              await this.callProvider(
                state,
                "publish",
                "review",
                path.join(dir, "runs", record.runId),
                {
                  ...options,
                  feedback: `Exact publication preview:\n${readFileSync(previewFile, "utf8")}`,
                },
              ),
            );
            record.summary += "\nIndependent review: " + review.summary;
            record.findings.push(...review.findings);
          }
          record.status = "awaiting-approval";
          record.reviewFingerprint = await this.fingerprint(state, "publish");
          this.storage.save(state);
          return { ...preview, diff: diff + "\n" + untrackedDiff, previewFile };
        } catch (error) {
          record.status = "failed";
          record.error = error instanceof Error ? error.message : String(error);
          this.storage.save(state);
          throw error;
        }
      }
      if (state.stations.publish?.status !== "approved")
        throw new Error("Preview and approve publish before pushing.");
      const config = loadConfig(this.root);
      if (!config.github.account)
        throw new Error(
          "Set the intended exact GitHub username in kitchen.config.json before publication.",
        );
      if ((await this.github.identity()) !== config.github.account)
        throw new Error(
          "Active GitHub identity differs from the intended account.",
        );
      // Persist approval before side effects; retries look up an already-created PR.
      const existing = await this.github.find(
        config.github.repository,
        state.branch,
      );
      await commitFiles(
        state.worktree,
        await sourceFiles(state.worktree, feature).then((files) => [
          ...files.filter((f) =>
            this.contracts(state).allowedPaths.includes(f),
          ),
          this.document(state, "verification"),
        ]),
        `feat(${feature}): implement and verify approved behavior`,
      );
      if (
        (await this.fingerprint(state, "publish")) !==
        state.stations.publish.approval?.fingerprint
      )
        throw new Error(
          "Candidate changed during publication. Renew verification.",
        );
      await this.github.push(state.worktree, state.branch);
      state.pr =
        existing ??
        (await this.github.create({
          repository: config.github.repository,
          base: "develop",
          head: state.branch,
          ...preview,
          bodyFile,
        }));
      this.storage.save(state);
      return { ...preview, url: state.pr };
    });
  }
}
