import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cliProvider } from "../src/providers.ts";
import { parseDeepSeekOutput } from "../src/deepseek.ts";
import { runProcess } from "../src/process.ts";
import type { ProcessResult } from "../src/process.ts";
import type { ProviderMetrics, ProviderRequest } from "../src/types.ts";

vi.mock("../src/process.ts", () => ({ runProcess: vi.fn() }));
const processMock = vi.mocked(runProcess);
const digest = "a".repeat(64);
const candidate = {
  summary: "Intent captured", questions: [], document: "# Intent\nCustomers need a clearer notice.",
  files: [], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [],
};
const savedFinal = JSON.parse(readFileSync(new URL("./fixtures/dsh-intent-invalid-final.json", import.meta.url), "utf8"));
const wire = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const completed = (text: string, sessionId = "session-corrected") => wire([
  { type: "session", sessionId },
  { type: "final", sessionId, reason: { kind: "completed" }, text },
]);
const savedWire = wire([{ type: "session", sessionId: savedFinal.sessionId }, savedFinal]);
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

function request(): ProviderRequest {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-dsh-contract-"));
  return {
    station: "intent", role: "author", cwd: root, runDir: path.join(root, "run"),
    prompt: "Capture product intent. Human answer: Company owners need a clearer notice.",
    timeoutMs: 1000,
    config: { provider: "deepseek", model: "local", dsh: {
      version: "0.2.2-alpha.3", baseURL: "http://127.0.0.1:11434/v1", contextWindow: 8192, maxTokens: 2048,
    } },
  };
}

function respond(raw: string, result: Partial<ProcessResult> = {}, onRun?: () => void) {
  processMock.mockImplementationOnce(async (options) => {
    onRun?.();
    const patch = options.args[options.args.indexOf("--patch") + 1]!;
    const measurement = patch.replace("-dsh.patch.yml", "-token-events.jsonl");
    writeFileSync(measurement, wire([
      { type: "request", step: 1, inputBytes: Buffer.byteLength(options.input!), toolResultBytes: 0 },
      { type: "response", step: 1, usage: { inputTokens: 20, outputTokens: 8 }, finish: "stop" },
    ]));
    const failureReason = options.onOutput?.("stdout", raw);
    return { code: failureReason ? -1 : 0, stdout: raw, stderr: "", timedOut: false, cancelled: false,
      ...(failureReason ? { failureReason } : {}), ...result };
  });
}

beforeEach(() => {
  processMock.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "local", digest }] }))));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("DSH bounded contract regeneration", () => {
  it("resumes only the named session and regenerates with fresh full context", async () => {
    const req = request();
    req.session = { id: "session-saved", home: path.join(req.cwd, "session-home") };
    req.prompt = "Answer delta";
    req.freshPrompt = "FULL ORIGINAL CONTEXT";
    const ids: string[] = []; req.onSession = id => ids.push(id);
    respond(completed("invalid", "session-saved"));
    respond(completed(JSON.stringify(candidate), "session-corrected"));
    await cliProvider(req);
    expect(processMock.mock.calls[0]![0].args).toContain("--session-id");
    expect(processMock.mock.calls[0]![0].env!.DSH_HOME).toBe(req.session.home);
    expect(processMock.mock.calls[1]![0].args).not.toContain("--session-id");
    expect(processMock.mock.calls[1]![0].input).toContain("FULL ORIGINAL CONTEXT");
    expect(ids).toEqual([]);
  });
  it("rejects mismatched resumed identities without regeneration", async () => {
    const req = request(); req.session = { id: "session-saved", home: path.join(req.cwd, "session-home") };
    respond(completed(JSON.stringify(candidate), "session-other"));
    await expect(cliProvider(req)).rejects.toThrow("different session");
    expect(processMock).toHaveBeenCalledTimes(1);
  });
  it("strictly rejects the saved final response and regenerates with both attempts preserved", async () => {
    expect(() => parseDeepSeekOutput(savedWire)).toThrow(/DSH final answer violated JSON contract.*session-e02c3461/);
    const req = request();
    const metrics: ProviderMetrics[] = [];
    respond(savedWire);
    const corrected = completed(JSON.stringify(candidate));
    respond(corrected);
    expect(await cliProvider({ ...req, onMetrics: (value) => metrics.push(value) })).toEqual(candidate);
    expect(processMock).toHaveBeenCalledTimes(2);
    const second = processMock.mock.calls[1]![0];
    expect(second.input).toContain(req.prompt);
    expect(second.input).toContain("KITCHEN CORRECTIVE REGENERATION");
    expect(second.input).toContain("without commentary or Markdown fences");
    expect(second.env!.DSH_HOME).not.toBe(processMock.mock.calls[0]![0].env!.DSH_HOME);
    expect(readFileSync(path.join(req.runDir, "author-events.jsonl"), "utf8")).toBe(savedWire);
    expect(readFileSync(path.join(req.runDir, "contract-retry/author-events.jsonl"), "utf8")).toBe(corrected);
    expect(json(path.join(req.runDir, "author-process.json"))).toMatchObject({
      code: 0, timedOut: false, validationError: expect.stringContaining("DSH final answer violated JSON contract"),
    });
    expect(json(path.join(req.runDir, "contract-retry/author-process.json"))).not.toHaveProperty("validationError");
    expect(json(path.join(req.runDir, "author-output.json"))).toEqual(candidate);
    expect(json(path.join(req.runDir, "author-attempts.json"))).toMatchObject({
      status: "completed", timeoutMs: req.timeoutMs, original: { runDir: path.resolve(req.runDir) },
      retry: { runDir: path.resolve(req.runDir, "contract-retry") },
    });
    expect(metrics).toHaveLength(2);
    expect(metrics.map((value) => value.tokens?.knownTotalTokens)).toEqual([28, 28]);
    for (const dir of [req.runDir, path.join(req.runDir, "contract-retry")]) {
      expect(existsSync(path.join(dir, "author-token-events.jsonl"))).toBe(true);
      expect(existsSync(path.join(dir, "author-prompt.txt"))).toBe(true);
      expect(json(path.join(dir, "author-schema.json")).properties.files.maxItems).toBe(0);
    }
  });

  it("regenerates valid JSON that violates the intent station contract", async () => {
    const req = request();
    const proposal = JSON.parse(savedFinal.text.match(/```json\n([^]*?)\n```/)[1]);
    const questions = { ...candidate, document: null, questions: [{ id: "audience", text: "Who needs this?" }] };
    respond(completed(JSON.stringify(proposal), "session-proposal"));
    respond(completed(JSON.stringify(questions)));
    expect(await cliProvider(req)).toEqual(questions);
    expect(processMock.mock.calls[1]![0].input).toContain("Invalid intent author output");
  });

  it.each(["spec", "plan", "test-plan"] as const)(
    "corrects invalid %s candidates before exposing output",
    async (station) => {
      const proposal = JSON.parse(savedFinal.text.match(/```json\n([^]*?)\n```/)[1]);
      const corrected = {
        ...candidate, document: `# ${station}\nComplete document.`,
        allowedPaths: station === "plan" ? ["src/answer.ts", "src/answer.test.ts"] : [],
        unitTestFiles: station === "test-plan" ? ["src/answer.test.ts"] : [],
      };
      for (const invalid of [
        { ...candidate, document: null },
        { ...candidate, document: " \n\t" },
        { ...candidate, files: proposal.files },
        proposal,
      ]) {
        const req = { ...request(), station };
        respond(completed(JSON.stringify(invalid), "session-invalid-document"));
        respond(completed(JSON.stringify(corrected)), {}, () => {
          expect(existsSync(path.join(req.runDir, "author-output.json"))).toBe(false);
          expect(existsSync(path.join(req.runDir, "author-answer.json"))).toBe(false);
        });
        expect(await cliProvider(req)).toEqual(corrected);
        const calls = processMock.mock.calls.slice(-2);
        expect(calls[1]![0].input).toContain(`Invalid ${station} author output`);
        expect(calls[1]![0].input).toContain("KITCHEN CORRECTIVE REGENERATION");
        expect(json(path.join(req.runDir, "author-process.json"))).toHaveProperty("validationError");
        expect(json(path.join(req.runDir, "author-attempts.json")).status).toBe("completed");
        expect(json(path.join(req.runDir, "author-output.json"))).toEqual(corrected);
        expect(json(path.join(req.runDir, "author-schema.json")).properties.files.maxItems).toBe(0);
      }
      expect(processMock).toHaveBeenCalledTimes(8);
    },
  );

  it("fails a document station after one invalid correction without exposing a candidate", async () => {
    const req = { ...request(), station: "spec" as const };
    const invalid = { ...candidate, document: null };
    respond(completed(JSON.stringify(invalid), "session-spec-invalid"));
    respond(completed(JSON.stringify(invalid), "session-spec-retry-invalid"));
    await expect(cliProvider(req)).rejects.toThrow(/Invalid spec author output.*after one corrective regeneration/);
    expect(processMock).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(req.runDir, "author-output.json"))).toBe(false);
    expect(existsSync(path.join(req.runDir, "contract-retry/author-output.json"))).toBe(false);
    expect(json(path.join(req.runDir, "author-attempts.json")).status).toBe("failed");
  });

  it("stops after one failed correction and reports both sessions and evidence paths", async () => {
    const req = request();
    respond(savedWire);
    respond(completed("```json\n{}\n```", "session-second-invalid"));
    const error: unknown = await cliProvider(req).catch((value: Error) => value);
    if (!(error instanceof Error)) throw new Error("Expected contract failure");
    expect(error.message).toContain("DSH final answer violated JSON contract");
    expect(error.message).toContain("session-second-invalid");
    expect(error.message).toContain(savedFinal.sessionId);
    expect(error.message).toContain(path.resolve(req.runDir, "contract-retry/author-events.jsonl"));
    expect(error.message).toContain(path.resolve(req.runDir, "author-events.jsonl"));
    expect(processMock).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(req.runDir, "author-output.json"))).toBe(false);
    expect(json(path.join(req.runDir, "author-attempts.json")).retry.error).toContain("session-second-invalid");
    expect(json(path.join(req.runDir, "author-attempts.json")).status).toBe("failed");
  });

  it("shares the original timeout across both attempts", async () => {
    const req = request();
    let now = 10000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    respond(savedWire, {}, () => { now += 400; });
    respond(completed(JSON.stringify(candidate)));
    await cliProvider(req);
    expect(processMock.mock.calls.map(([options]) => options.timeoutMs)).toEqual([1000, 600]);
  });

  it.each(["deadline", "cancelled"])("does not regenerate after %s", async (failure) => {
    const req = request();
    let now = 10000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const controller = new AbortController();
    respond(savedWire, {}, () => {
      if (failure === "deadline") now += req.timeoutMs;
      else controller.abort();
    });
    await expect(cliProvider({ ...req, signal: controller.signal })).rejects.toThrow(/DSH final answer violated JSON contract/);
    expect(processMock).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(req.runDir, "contract-retry"))).toBe(false);
  });

  it.each(["stream", "incomplete", "tool", "truncated", "process", "timeout", "budget"])("does not regenerate a %s failure", async (failure) => {
    const req = request();
    const events = failure === "stream" ? "not a stream\n"
      : failure === "incomplete" ? wire([{ type: "session", sessionId: "session-incomplete" }])
      : failure === "tool" ? wire([{ type: "session", sessionId: "session-tool" }, { type: "tool_call", tool: "read", callId: "r" }])
      : failure === "truncated" ? wire([{ type: "session", sessionId: "session-truncated" }, { type: "final", sessionId: "session-truncated", reason: { kind: "max-tokens" }, text: "{}" }])
      : savedWire;
    const result = failure === "process" ? { code: 1 }
      : failure === "timeout" ? { code: -1, timedOut: true }
      : failure === "budget" ? { code: -1, failureReason: "KITCHEN_TOKEN_BUDGET: input limit" } : {};
    respond(events, result);
    await expect(cliProvider(req)).rejects.toThrow();
    expect(processMock).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(req.runDir, "contract-retry"))).toBe(false);
  });
});
