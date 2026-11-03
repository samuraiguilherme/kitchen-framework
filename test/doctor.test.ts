import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { doctor } from "../src/doctor.ts";
import { loadConfig } from "../src/config.ts";
import { hostedProvider } from "../src/providers.ts";
import { runProcess } from "../src/process.ts";
import type { ProcessOptions, ProcessResult } from "../src/process.ts";
import { stationOrder } from "../src/domain.ts";

vi.mock("../src/process.ts", () => ({ runProcess: vi.fn() }));
const run = vi.mocked(runProcess);
const success: ProcessResult = {
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  cancelled: false,
};
const rejection =
  "The 'unavailable-model' model is not supported when using Codex with a ChatGPT account.";
let root: string;

function config(overrides = {}) {
  writeFileSync(
    path.join(root, "kitchen.config.json"),
    JSON.stringify(overrides),
  );
}
function isProbe(options: ProcessOptions) {
  return (
    options.args.includes("--output-schema") ||
    options.args.includes("--json-schema")
  );
}
async function fakeProcess(options: ProcessOptions): Promise<ProcessResult> {
  if (isProbe(options)) {
    const output = { summary: "Kitchen model probe OK", findings: [] };
    const index = options.args.indexOf("--output-last-message");
    if (index >= 0) {
      writeFileSync(options.args[index + 1]!, JSON.stringify(output));
      return { ...success, stdout: '{"type":"turn.completed"}' };
    }
    return {
      ...success,
      stdout: JSON.stringify({ structured_output: output, is_error: false }),
    };
  }
  return {
    ...success,
    stdout:
      options.command === "pnpm"
        ? "9.15.9"
        : options.args.includes("--json")
          ? '{"loggedIn":true}'
          : "Available",
  };
}
function probes() {
  return run.mock.calls.map(([options]) => options).filter(isProbe);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "kitchen doctor "));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@9.15.9" }),
  );
  run.mockImplementation(fakeProcess);
});
afterEach(() => vi.resetAllMocks());

describe("live model readiness diagnostics", () => {
  it("does not require pnpm in a project using another runtime", async () => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "npm@10.0.0" }));
    const results = await doctor(root);
    expect(results.some((result) => result.id === "pnpm")).toBe(false);
    expect(run.mock.calls.some(([options]) => options.command === "pnpm")).toBe(false);
  });
  it("checks pnpm availability without requiring a nonexistent version pin", async () => {
    writeFileSync(path.join(root, "package.json"), "{}");
    config({ profiles: { types: { kind: "command", command: "pnpm", args: ["check"], parser: "exit-code", timeoutMs: 1000 } } });
    expect((await doctor(root)).find((result) => result.id === "pnpm")?.status).toBe("passed");
  });
  it("checks and probes the replacement desktop runtime without rewriting config", async () => {
    const bin = path.join(root, "OpenAI", "Codex", "bin");
    const missing = path.join(bin, "0000000000000000", "codex.exe");
    const installed = path.join(bin, "1111111111111111", "codex.exe");
    mkdirSync(path.dirname(installed), { recursive: true });
    writeFileSync(installed, "fixture");
    config({
      providers: { author: { provider: "codex", executable: missing } },
    });
    const results = await doctor(root);
    expect(results.find((result) => result.id === "codex-cli")).toMatchObject({
      status: "passed",
      reason: `${installed}: Available`,
    });
    expect(probes()[0]?.command).toBe(installed);
    expect(
      run.mock.calls.some(
        ([request]) =>
          request.command === installed &&
          request.args.join(" ") === "login status",
      ),
    ).toBe(true);
    expect(loadConfig(root).providers.author.executable).toBe(missing);
  });
  it("ignores disabled reviewers and the unused publish author", async () => {
    config({
      providers: {
        review: { provider: "claude", executable: "unused-reviewer" },
      },
      stations: {
        spec: {
          review: { provider: "claude", executable: "unused-spec-reviewer" },
        },
        plan: {
          reviewEnabled: false,
          review: { provider: "claude", executable: "unused-plan-reviewer" },
        },
        publish: {
          author: { provider: "claude", executable: "unused-publish-author" },
        },
      },
    });
    const results = await doctor(root);
    expect(probes()).toHaveLength(1);
    expect(
      run.mock.calls.every(
        ([request]) => !request.command.startsWith("unused-"),
      ),
    ).toBe(true);
    expect(results.some((result) => result.id.startsWith("claude-"))).toBe(
      false,
    );
  });
  it.each(stationOrder)(
    "probes an opted-in %s reviewer without requiring the unused default",
    async (station) => {
      config({
        providers: {
          review: { provider: "claude", executable: "unused-reviewer" },
        },
        stations: {
          [station]: {
            reviewEnabled: true,
            review: { provider: "claude", model: "station-review" },
          },
        },
      });
      const results = await doctor(root);
      expect(probes()).toHaveLength(2);
      expect(probes()[1]?.args).toContain("station-review");
      expect(
        results.find((result) => result.id === "claude-model-2")?.reason,
      ).toContain(`stations.${station}.review`);
      expect(
        run.mock.calls.some(
          ([request]) => request.command === "unused-reviewer",
        ),
      ).toBe(false);
    },
  );
  it("probes and identifies distinct Windows sandbox selections", async () => {
    config({
      providers: {
        author: {
          provider: "codex",
          model: "same",
          windowsSandbox: "unelevated",
        },
        review: {
          provider: "codex",
          model: "same",
          windowsSandbox: "elevated",
        },
      },
      stations: { spec: { reviewEnabled: true } },
    });
    const results = await doctor(root);
    expect(probes()).toHaveLength(2);
    expect(probes()[0]?.args).toContain('windows.sandbox="unelevated"');
    expect(probes()[1]?.args).toContain('windows.sandbox="elevated"');
    expect(
      results.find((result) => result.id === "codex-model-1")?.reason,
    ).toContain("windowsSandbox=unelevated");
  });
  it("checks explicit default models and distinct station overrides once per provider/model/executable", async () => {
    config({
      providers: {
        author: {
          provider: "codex",
          model: "author-model",
          executable: "C:/CLIs with spaces/codex.cmd",
        },
        review: { provider: "claude", model: "review-model" },
      },
      stations: {
        spec: {
          reviewEnabled: true,
          author: {
            provider: "codex",
            model: "author-model",
            executable: "C:/CLIs with spaces/codex.cmd",
          },
        },
        plan: {
          reviewEnabled: true,
          review: { provider: "claude", model: "station-model" },
        },
      },
    });
    const results = await doctor(root);
    expect(probes()).toHaveLength(3);
    expect(probes().map((p) => p.args[p.args.indexOf("--model") + 1])).toEqual([
      "author-model",
      "review-model",
      "station-model",
    ]);
    expect(probes()[0]!.command).toBe("C:/CLIs with spaces/codex.cmd");
    const checks = results.filter((r) => r.id.includes("-model-"));
    expect(checks).toHaveLength(3);
    expect(checks.every((r) => r.required && r.status === "passed")).toBe(true);
    expect(checks[0]!.reason).toContain("author-model");
    expect(checks[2]!.reason).toContain("stations.plan.review");
    expect(
      run.mock.calls.some(
        ([p]) =>
          p.command === "C:/CLIs with spaces/codex.cmd" &&
          p.args.join(" ") === "login status",
      ),
    ).toBe(true);
  });

  it("probes inherited CLI defaults without inventing a model override", async () => {
    const results = await doctor(root);
    expect(probes()).toHaveLength(1);
    expect(probes().every((p) => !p.args.includes("--model"))).toBe(true);
    expect(
      results
        .filter((r) => r.id.includes("-model-"))
        .every((r) => r.reason?.includes("CLI default")),
    ).toBe(true);
  });

  it("probes intent author overrides and ignores unused intent reviewers", async () => {
    config({
      stations: {
        intent: {
          author: { provider: "codex", model: "intent-author" },
          review: { provider: "claude", model: "unused-intent-review" },
        },
      },
    });
    const results = await doctor(root);
    expect(probes()).toHaveLength(2);
    expect(probes().some((probe) => probe.args.includes("intent-author"))).toBe(
      true,
    );
    expect(
      probes().some((probe) => probe.args.includes("unused-intent-review")),
    ).toBe(false);
    expect(
      results.some((result) =>
        result.reason?.includes("stations.intent.author"),
      ),
    ).toBe(true);
    expect(
      results.some((result) =>
        result.reason?.includes("stations.intent.review"),
      ),
    ).toBe(false);
  });

  it("isolates probes from repository instructions and retains local evidence", async () => {
    config({ stations: { spec: { reviewEnabled: true } } });
    const results = await doctor(root);
    expect(probes()).toHaveLength(2);
    for (const p of probes()) {
      expect(p.cwd).not.toBe(root);
      expect(path.relative(root, p.cwd).startsWith("..")).toBe(true);
      expect(p.input).toContain("Kitchen model probe OK");
      expect(p.timeoutMs).toBeLessThanOrEqual(60000);
      if (p.args[0] === "exec") {
        expect(p.args).toContain("read-only");
        expect(p.args).toContain("--ephemeral");
        expect(p.args).toContain("--skip-git-repo-check");
      } else expect(p.args[p.args.indexOf("--tools") + 1]).toBe("");
    }
    for (const check of results.filter((r) => r.id.includes("-model-"))) {
      expect(existsSync(check.evidence!)).toBe(true);
    }
  });

  it("fails on Codex stdout errors even when login succeeds, preferring the rejection over cache warnings", async () => {
    run.mockImplementation(async (p) =>
      p.command === "codex" && isProbe(p)
        ? {
            ...success,
            code: 1,
            stderr: "Model cache warning",
            stdout: JSON.stringify({
              type: "turn.failed",
              error: {
                message: JSON.stringify({
                  status: 400,
                  error: { message: rejection },
                }),
              },
            }),
          }
        : fakeProcess(p),
    );
    const results = await doctor(root);
    expect(results.find((r) => r.id === "codex-auth")?.status).toBe("passed");
    expect(results.find((r) => r.id === "codex-model-1")).toMatchObject({
      required: true,
      status: "failed",
      reason: expect.stringContaining(rejection),
    });
  });

  it.each(["timedOut", "cancelled"] as const)(
    "reports %s instead of model readiness",
    async (flag) => {
      const controller = new AbortController();
      run.mockImplementation(async (p) =>
        isProbe(p) ? { ...success, code: -1, [flag]: true } : fakeProcess(p),
      );
      const results = await doctor(root, { signal: controller.signal });
      expect(results.find((r) => r.id === "codex-model-1")).toMatchObject({
        status: "failed",
        reason: expect.stringMatching(
          flag === "timedOut" ? /timed out/ : /cancelled/,
        ),
      });
      expect(probes().every((p) => p.signal === controller.signal)).toBe(true);
    },
  );

  it.each(["invalid JSON", "wrong response", "provider error"])(
    "rejects %s despite exit code zero",
    async (failure) => {
      config({ stations: { spec: { reviewEnabled: true } } });
      run.mockImplementation(async (p) => {
        if (!isProbe(p)) return fakeProcess(p);
        const index = p.args.indexOf("--output-last-message");
        const raw =
          failure === "invalid JSON"
            ? "not json"
            : JSON.stringify({ summary: "Something else", findings: [] });
        if (index >= 0) {
          writeFileSync(p.args[index + 1]!, raw);
          return { ...success };
        }
        return {
          ...success,
          stdout:
            failure === "provider error"
              ? JSON.stringify({
                  is_error: true,
                  result: "Model access denied",
                })
              : raw,
        };
      });
      const results = await doctor(root);
      expect(results.find((r) => r.id === "claude-model-2")?.status).toBe(
        "failed",
      );
      if (failure !== "provider error")
        expect(results.find((r) => r.id === "codex-model-1")?.status).toBe(
          "failed",
        );
      else
        expect(
          results.find((r) => r.id === "claude-model-2")?.reason,
        ).toContain("Model access denied");
    },
  );

  it("skips requests after failed authentication and marks readiness unverified", async () => {
    run.mockImplementation(async (p) =>
      p.command === "codex" && p.args.join(" ") === "login status"
        ? { ...success, code: 1 }
        : fakeProcess(p),
    );
    const results = await doctor(root);
    expect(probes()).toHaveLength(0);
    expect(results.find((r) => r.id === "codex-model-1")).toMatchObject({
      required: true,
      status: "unverified",
      reason: expect.stringMatching(/codex-auth/),
    });
  });

  it("rejects empty model configuration before launching a CLI", async () => {
    config({ providers: { author: { provider: "codex", model: " " } } });
    expect(() => loadConfig(root)).toThrow(/provider configuration/i);
    await expect(doctor(root)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("surfaces stdout-only rejections during station execution too", async () => {
    run.mockResolvedValue({
      ...success,
      code: 1,
      stdout: JSON.stringify({ type: "error", message: rejection }),
    });
    const runDir = path.join(root, "station-run");
    await expect(
      hostedProvider({
        station: "intent",
        role: "author",
        prompt: "Request",
        cwd: root,
        runDir,
        config: { provider: "codex" },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(rejection);
    expect(
      readFileSync(path.join(runDir, "author-process.json"), "utf8"),
    ).toContain("not supported");
  });
});
