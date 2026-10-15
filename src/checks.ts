import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import net from "node:net";
import spawn from "cross-spawn";
import { finding, hash, safePath } from "./domain.ts";
import { runProcess, stopProcess } from "./process.ts";
import { executeSetup } from "./setup-runner.ts";
import type {
  CheckDefinition,
  CheckResult,
  Finding,
  ManualObservation,
  Profile,
} from "./types.ts";

export function localUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
interface Assertion {
  fullName: string;
  status: string;
  failureMessages?: string[];
}
export function classifyTestOutput(
  raw: string,
  code: number,
  expectation: "red" | "green",
  acIds: string[],
): { status: string; total: number; failed: number; reason: string } {
  const unverified = (reason: string) => ({
    status: "unverified",
    total: 0,
    failed: 0,
    reason,
  });
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    return unverified("No parseable test report.");
  }
  if (
    !report ||
    !Array.isArray(report.testResults) ||
    report.testResults.some(
      (r: { assertionResults?: unknown } | null) =>
        !r || !Array.isArray(r.assertionResults),
    )
  )
    return unverified("Invalid test report structure.");
  const assertions: Assertion[] = report.testResults.flatMap(
    (r: { assertionResults?: Assertion[] }) => r.assertionResults ?? [],
  );
  const executed = assertions.filter((a) =>
    ["passed", "failed"].includes(a.status),
  );
  const failed = executed.filter((a) => a.status === "failed");
  const matches = (a: Assertion, id: string) =>
    new RegExp(`(?:^|[^A-Z0-9-])${id}(?:$|[^A-Z0-9-])`).test(a.fullName);
  const total = executed.length;
  if (
    !total ||
    report.numTotalTests !== assertions.length ||
    report.numFailedTests !== failed.length ||
    report.numPassedTests !== executed.length - failed.length
  )
    return unverified("Zero tests or inconsistent discovered/executed counts.");
  if (acIds.some((id) => !executed.some((a) => matches(a, id))))
    return {
      ...unverified("A required criterion has no executed test."),
      total,
      failed: failed.length,
    };
  const infrastructure =
    /SyntaxError|TypeError|ReferenceError|Cannot find|module not found|ECONN|ENOTFOUND|EACCES|ENOENT|failed to (?:load|resolve)|timed?\s*out/i;
  const behavioral = failed.every(
    (a) =>
      (a.failureMessages ?? []).length > 0 &&
      a.failureMessages!.every(
        (m) =>
          /AssertionError|expect\(|expected .* (?:to|received)|toBe|toEqual|toThrow/i.test(
            m,
          ) && !infrastructure.test(m),
      ),
  );
  const allCoveredRed =
    acIds.length > 0 && acIds.every((id) => failed.some((a) => matches(a, id)));
  const onlyCoveredFailures = failed.every((a) =>
    acIds.some((id) => matches(a, id)),
  );
  if (
    expectation === "red" &&
    code > 0 &&
    executed.length === assertions.length &&
    failed.length &&
    behavioral &&
    allCoveredRed &&
    onlyCoveredFailures &&
    !report.numRuntimeErrorTestSuites &&
    !report.unhandledErrors?.length
  )
    return {
      status: "expected-red",
      total,
      failed: failed.length,
      reason:
        "Approved missing behavior reached assertion failures for each mapped criterion.",
    };
  if (
    expectation === "green" &&
    code === 0 &&
    report.success !== false &&
    !report.numFailedTestSuites &&
    !report.numRuntimeErrorTestSuites &&
    !report.unhandledErrors?.length &&
    !failed.length &&
    !assertions.some((a) => !["passed", "failed"].includes(a.status))
  )
    return {
      status: "passed",
      total,
      failed: 0,
      reason: "All discovered tests executed successfully.",
    };
  return {
    status: "failed",
    total,
    failed: failed.length,
    reason:
      expectation === "red"
        ? "Expected behavioral RED was not established; inspect infrastructure, skipped tests, and failure coverage."
        : "Required GREEN was not established.",
  };
}
export function validateCheckPlan(
  acIds: string[],
  checks: CheckDefinition[],
  profiles: Record<string, Pick<Profile, "kind">>,
): Finding[] {
  const findings: Finding[] = [];
  if (new Set(checks.map((c) => c.id)).size !== checks.length)
    findings.push(
      finding(
        "duplicate-check",
        "Duplicate check IDs",
        "Use distinct check IDs.",
      ),
    );
  for (const check of checks) {
    if (!profiles[check.profile])
      findings.push(
        finding(
          "unknown-profile",
          check.profile,
          "Select an explicit configured check profile.",
        ),
      );
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(check.id))
      findings.push(
        finding("invalid-check-id", check.id, "Use kebab-case IDs."),
      );
    if (check.acIds.some((id) => !acIds.includes(id)))
      findings.push(
        finding(
          "unknown-criterion",
          check.id,
          "Reference only defined acceptance criteria.",
        ),
      );
    if (
      profiles[check.profile]?.kind === "unit" &&
      (!check.files.length || !check.required)
    )
      findings.push(
        finding(
          "unit-scope",
          check.id,
          "Unit tests need explicit files and must be required.",
        ),
      );
  }
  for (const id of acIds)
    if (
      !checks.some(
        (c) =>
          c.required &&
          profiles[c.profile]?.kind !== "command" &&
          profiles[c.profile] &&
          c.acIds.includes(id),
      )
    )
      findings.push(
        finding(
          "uncovered-criterion",
          id,
          "Map the criterion to a required behavioral or observed check.",
        ),
      );
  if (!checks.some((c) => c.required && profiles[c.profile]?.kind === "unit"))
    findings.push(
      finding(
        "unit-tests-required",
        "No required unit test profile",
        "Define required unit tests before implementation.",
      ),
    );
  return findings;
}
export function playwrightToVitest(raw: string): string {
  const report = JSON.parse(raw);
  const assertions: Assertion[] = [];
  const walk = (
    suites: Array<{
      title: string;
      suites?: unknown[];
      specs?: Array<{
        title: string;
        tests: Array<{
          status: string;
          results: Array<{
            status: string;
            errors?: Array<{ message?: string }>;
          }>;
        }>;
      }>;
    }>,
    prefix = "",
  ) => {
    for (const suite of suites) {
      for (const spec of suite.specs ?? [])
        for (const test of spec.tests)
          assertions.push({
            fullName: `${prefix} ${suite.title} ${spec.title}`,
            status:
              test.status === "expected" &&
              test.results.every((r) => r.status === "passed")
                ? "passed"
                : test.status === "skipped"
                  ? "pending"
                  : "failed",
            failureMessages: test.results.flatMap(
              (r) => r.errors?.map((e) => e.message ?? "Browser failure") ?? [],
            ),
          });
      walk(
        (suite.suites ?? []) as Parameters<typeof walk>[0],
        `${prefix} ${suite.title}`,
      );
    }
  };
  walk(report.suites ?? []);
  return JSON.stringify({
    numTotalTests: assertions.length,
    numPassedTests: assertions.filter((a) => a.status === "passed").length,
    numFailedTests: assertions.filter((a) => a.status === "failed").length,
    testResults: [{ assertionResults: assertions }],
  });
}
function expand(
  args: string[],
  files: string[],
  baseUrl?: string,
  port?: number,
): string[] {
  return args.flatMap((arg) =>
    arg === "{files}"
      ? files
      : [
          arg
            .replaceAll("{baseUrl}", baseUrl ?? "")
            .replaceAll("{port}", String(port ?? "")),
        ],
  );
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
export interface ExecuteCheckInput {
  definition: CheckDefinition;
  profile: Profile;
  root: string;
  runDir: string;
  fingerprint: string;
  green: boolean;
  signal?: AbortSignal;
  observations?: ManualObservation[];
}

export async function executeCheck(
  input: ExecuteCheckInput,
): Promise<CheckResult> {
  return executeOne(input);
}

async function executeOne(
  input: ExecuteCheckInput,
  preparedSetup?: Awaited<ReturnType<typeof executeSetup>>,
): Promise<CheckResult> {
  const started = performance.now();
  const { definition: check, profile, root, runDir, fingerprint } = input;
  const testFiles = check.files.map((file) => safePath(root, file));
  const result: CheckResult = {
    id: check.id,
    required: check.required,
    status: "unverified",
    acIds: check.acIds,
    sourceFingerprint: fingerprint,
  };
  const cwd =
    profile.cwd && profile.cwd !== "." ? safePath(root, profile.cwd) : root;
  mkdirSync(runDir, { recursive: true });
  const evidenceFile = path.join(runDir, `check-${check.id}.json`);
  result.evidence = evidenceFile;
  const finish = () => {
    result.durationMs = performance.now() - started;
    writeFileSync(evidenceFile, JSON.stringify(result, null, 2));
    result.evidenceHashes = Object.fromEntries(
      readdirSync(runDir)
        .filter((file) => file.endsWith(`-${check.id}.json`))
        .map((file) => {
          const absolute = path.join(runDir, file);
          return [absolute, hash(readFileSync(absolute))];
        }),
    );
    return result;
  };
  if (input.signal?.aborted) {
    result.status = "failed";
    result.reason = "Check cancelled.";
    return finish();
  }
  if (profile.kind === "manual") {
    const observation = input.observations?.find((o) => o.id === check.id);
    if (
      !observation?.observation.trim() ||
      !observation.evidence.length ||
      observation.evidence.some((file) => !existsSync(safePath(root, file)))
    ) {
      result.reason =
        "A human observation and candidate-local evidence files are required.";
      return finish();
    }
    if (
      observation.status === "not-applicable" &&
      !observation.reason?.trim()
    ) {
      result.reason = "N/A requires a recorded reason.";
      return finish();
    }
    result.status = observation.status;
    result.observation = observation.observation;
    result.reason = observation.reason;
    // Embed content hashes/contents in the raw evidence so later edits cannot rewrite observations.
    writeFileSync(
      path.join(runDir, `manual-${check.id}.json`),
      JSON.stringify(
        {
          ...observation,
          files: observation.evidence.map((file) => ({
            file,
            content: readFileSync(safePath(root, file), "base64"),
          })),
        },
        null,
        2,
      ),
    );
    return finish();
  }
  if (
    ["integration", "browser"].includes(profile.kind) &&
    (!profile.fixture || !existsSync(safePath(root, profile.fixture)))
  ) {
    result.reason = "Configured isolated local fixture is unavailable.";
    return finish();
  }
  if (
    Object.entries(profile.env ?? {}).some(
      ([key, value]) =>
        /url|host|endpoint/i.test(key) &&
        !localUrl(value) &&
        !["localhost", "127.0.0.1", "::1"].includes(value),
    )
  ) {
    result.reason = "Fixture environment contains a nonlocal endpoint.";
    return finish();
  }
  for (const file of check.files)
    if (!existsSync(safePath(root, file))) {
      result.reason = `Missing planned test file ${file}`;
      return finish();
    }
  let preview: ReturnType<typeof spawn> | undefined;
  let baseUrl: string | undefined;
  let previewLog = "";
  try {
    if (profile.setup) {
      const setup =
        preparedSetup ??
        (await executeSetup({ root, cwd, profile, signal: input.signal }));
      writeFileSync(
        path.join(runDir, `setup-${check.id}.json`),
        JSON.stringify({
          ...setup,
          sharedSetup: preparedSetup !== undefined,
          profile: check.profile,
          cwd,
          ...profile.setup,
          fingerprint,
        }),
      );
      if (setup.code !== 0) {
        result.reason =
          "Local dependency setup failed; this is infrastructure, not behavioral RED.";
        return finish();
      }
    }
    if (profile.kind === "browser") {
      if (
        !profile.preview ||
        !profile.preview.args.some((a) => a.includes("{port}"))
      ) {
        result.reason = "Preview must bind its assigned candidate port.";
        return finish();
      }
      const build = await runProcess({
        ...profile.preview.build,
        cwd,
        timeoutMs: profile.timeoutMs!,
        signal: input.signal,
        env: { ...profile.env, NODE_ENV: "test" },
      });
      writeFileSync(
        path.join(runDir, `build-${check.id}.json`),
        JSON.stringify(build),
      );
      if (build.code !== 0) {
        result.status = "failed";
        result.reason = "Candidate preview build failed.";
        return finish();
      }
      const port = await freePort();
      baseUrl = `http://127.0.0.1:${port}`;
      preview = spawn(
        profile.preview.command,
        expand(profile.preview.args, [], baseUrl, port),
        {
          cwd,
          env: {
            ...process.env,
            ...profile.env,
            PORT: String(port),
            KITCHEN_SOURCE_FINGERPRINT: fingerprint,
          },
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: "pipe",
        },
      );
      preview.on("error", (error) => {
        previewLog += error.message;
      });
      preview.stdout?.on("data", (d) => {
        previewLog = (previewLog + d).slice(-100000);
      });
      preview.stderr?.on("data", (d) => {
        previewLog = (previewLog + d).slice(-100000);
      });
      const deadline = Date.now() + Math.min(profile.timeoutMs!, 30000);
      let ready = false;
      while (
        Date.now() < deadline &&
        preview.exitCode === null &&
        !input.signal?.aborted
      ) {
        try {
          const response = await fetch(
            baseUrl + (profile.preview.readyPath ?? "/"),
            { signal: AbortSignal.timeout(1000), redirect: "error" },
          );
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* bounded readiness polling */
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!ready) {
        result.status = "failed";
        result.reason = "Candidate preview did not become ready.";
        return finish();
      }
    }
    const startedAt = new Date().toISOString();
    const execution = await runProcess({
      command: profile.command!,
      args: expand(profile.args!, testFiles, baseUrl),
      cwd,
      timeoutMs: profile.timeoutMs!,
      signal: input.signal,
      env: {
        ...profile.env,
        CI: "1",
        NODE_ENV: "test",
        KITCHEN_BASE_URL: baseUrl ?? "",
        KITCHEN_SOURCE_FINGERPRINT: fingerprint,
      },
    });
    writeFileSync(
      path.join(runDir, `raw-${check.id}.json`),
      JSON.stringify(
        {
          ...execution,
          startedAt,
          finishedAt: new Date().toISOString(),
          profile: check.profile,
          cwd,
          command: profile.command,
          args: expand(profile.args!, testFiles, baseUrl),
          baseUrl,
          fingerprint,
        },
        null,
        2,
      ),
    );
    if (execution.cancelled || execution.timedOut) {
      result.status = "failed";
      result.reason = execution.cancelled
        ? "Check cancelled."
        : "Check timed out.";
      return finish();
    }
    if (profile.parser === "exit-code") {
      result.status = execution.code === 0 ? "passed" : "failed";
      result.reason = "Command exit evidence; no behavioral coverage claimed.";
    } else {
      let raw = execution.stdout;
      try {
        if (profile.parser === "playwright-json") raw = playwrightToVitest(raw);
      } catch {
        raw = "";
      }
      Object.assign(
        result,
        classifyTestOutput(
          raw,
          execution.code,
          input.green ? "green" : check.expectation,
          check.acIds,
        ),
      );
    }
    return finish();
  } finally {
    if (preview) {
      stopProcess(preview);
      writeFileSync(path.join(runDir, `preview-${check.id}.log`), previewLog);
    }
  }
}

/** Run explicitly independent checks, keeping exclusive checks as barriers. */
export async function executeChecks(
  input: Omit<ExecuteCheckInput, "definition" | "profile"> & {
    definitions: CheckDefinition[];
    profiles: Record<string, Profile>;
  },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const setups = new Map<string, Awaited<ReturnType<typeof executeSetup>>>();
  const setupKeys = new Map<string, string>();
  // Complete all dependency writes before launching any concurrent readers.
  for (const definition of input.definitions) {
    const profile = input.profiles[definition.profile];
    if (!profile)
      throw new Error(`Unknown check profile: ${definition.profile}`);
    if (!profile.setup || profile.kind === "manual") continue;
    const cwd =
      profile.cwd && profile.cwd !== "."
        ? safePath(input.root, profile.cwd)
        : input.root;
    const key = JSON.stringify({ cwd, setup: profile.setup, env: profile.env });
    setupKeys.set(definition.profile, key);
    if (!setups.has(key))
      setups.set(
        key,
        await executeSetup({
          root: input.root,
          cwd,
          profile,
          signal: input.signal,
        }),
      );
  }
  const pending = input.definitions.map((_, index) => index);
  const active = new Map<number, Promise<void>>();
  const groups = new Set<string>();
  let exclusiveActive = false;
  let failure: unknown;
  const profileAt = (index: number) =>
    input.profiles[input.definitions[index]!.profile]!;
  const parallel = (index: number) => {
    const profile = profileAt(index);
    return (
      profile.parallelSafe === true &&
      !["browser", "manual"].includes(profile.kind)
    );
  };
  const groupsAt = (index: number) => {
    const profile = profileAt(index);
    const directory =
      profile.cwd && profile.cwd !== "."
        ? safePath(input.root, profile.cwd)
        : input.root;
    const cwd = existsSync(directory)
      ? realpathSync(directory)
      : path.resolve(directory);
    const canonical = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    const resources = [
      profile.resourceGroup === undefined
        ? `cwd:${canonical(cwd)}`
        : `group:${profile.resourceGroup}`,
    ];
    if (profile.fixture) {
      const fixture = safePath(input.root, profile.fixture);
      resources.push(
        `fixture:${canonical(existsSync(fixture) ? realpathSync(fixture) : fixture)}`,
      );
    }
    return resources;
  };
  const start = (index: number) => {
    const definition = input.definitions[index]!;
    const resources = groupsAt(index);
    const exclusive = !parallel(index);
    if (exclusive) exclusiveActive = true;
    for (const resource of resources) groups.add(resource);
    const execution = executeOne(
      { ...input, definition, profile: profileAt(index) },
      setups.get(setupKeys.get(definition.profile) ?? ""),
    )
      .then((result) => {
        results[index] = result;
      })
      .catch((error) => {
        failure ??= error;
      })
      .finally(() => {
        active.delete(index);
        for (const resource of resources) groups.delete(resource);
        if (exclusive) exclusiveActive = false;
      });
    active.set(index, execution);
  };
  while (pending.length || active.size) {
    if (failure !== undefined) {
      await Promise.all(active.values());
      throw failure;
    }
    if (exclusiveActive) {
      // Manual observations, browser builds and unopted-in profiles run alone.
    } else if (pending.length && !parallel(pending[0]!)) {
      if (!active.size) start(pending.shift()!);
    } else {
      for (let position = 0; position < pending.length && active.size < 2; ) {
        const index = pending[position]!;
        if (!parallel(index)) break;
        if (groupsAt(index).some((resource) => groups.has(resource))) {
          position++;
          continue;
        }
        pending.splice(position, 1);
        start(index);
      }
    }
    if (active.size) await Promise.race(active.values());
  }
  if (failure !== undefined) throw failure;
  return results;
}
