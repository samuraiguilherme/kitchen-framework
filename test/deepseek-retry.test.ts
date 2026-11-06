import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
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
    expect(ids).toEqual(["session-corrected"]);
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

  it("regenerates a verify report returned in document before exposing a candidate", async () => {
    const req = { ...request(), station: "verify" as const };
    const corrected = { ...candidate, summary: "Reviewed candidate and recorded evidence.", document: null };
    respond(completed(JSON.stringify({ ...corrected, document: "# Verification report\nAll required checks passed." }), "session-invalid-verify"));
    respond(completed(JSON.stringify(corrected)), {}, () => {
      expect(existsSync(path.join(req.runDir, "author-output.json"))).toBe(false);
      expect(existsSync(path.join(req.runDir, "author-answer.json"))).toBe(false);
    });
    expect(await cliProvider(req)).toEqual(corrected);
    expect(processMock).toHaveBeenCalledTimes(2);
    expect(processMock.mock.calls[1]![0].input).toContain("Invalid verify author output");
    expect(processMock.mock.calls[1]![0].input).toContain("KITCHEN CORRECTIVE REGENERATION");
    expect(json(path.join(req.runDir, "author-schema.json")).properties.document).toMatchObject({ type: "null" });
    expect(json(path.join(req.runDir, "author-attempts.json")).status).toBe("completed");
    expect(json(path.join(req.runDir, "author-output.json"))).toEqual(corrected);
  });

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

function recoveringRequest(): ProviderRequest {
  const req = request();
  req.config.dsh!.tokenPolicy = { version: 1, outputTokens: { author: 512 }, maxTokenRetries: 1 };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "local", digest, context_length: 8192 }] }))));
  return req;
}

function limited(req: ProviderRequest, options: {
  input?: number; cache?: number; output?: number; raw?: string; result?: Partial<ProcessResult>; missingUsage?: boolean;
  onRun?: () => void;
} = {}) {
  const sessionId = req.session?.id ?? "session-limited";
  const raw = options.raw ?? wire([
    { type: "session", sessionId },
    { type: "final", sessionId, reason: { kind: "max-tokens" }, text: "{}" },
  ]);
  processMock.mockImplementationOnce(async invocation => {
    options.onRun?.();
    const patch = invocation.args[invocation.args.indexOf("--patch") + 1]!;
    writeFileSync(patch.replace("-dsh.patch.yml", "-token-events.jsonl"), wire([
      { type: "request", step: 1, inputBytes: 120, toolResultBytes: 0 },
      { type: "failure", kind: "max-tokens", message: "DSH model stopped with max-tokens: incomplete generation" },
      { type: "response", step: 1, finish: "max-tokens",
        ...(options.missingUsage ? {} : { usage: { inputTokens: options.input ?? 100, cacheReadTokens: options.cache ?? 0, outputTokens: options.output ?? 512 } }) },
    ]));
    const failureReason = invocation.onOutput?.("stdout", raw);
    return { code: 1, rawCode: 1, stdout: raw, stderr: "", timedOut: false, cancelled: false,
      ...(failureReason ? { failureReason } : {}), ...options.result };
  });
}

describe("DSH bounded token recovery", () => {
  it("diagnoses rad's saved 16k/8k failure as context pressure with cached input included", async () => {
    const req = recoveringRequest();
    req.config.dsh!.contextWindow = 16384;
    req.config.dsh!.maxTokens = 8192;
    req.config.dsh!.tokenPolicy!.outputTokens!.author = 8192;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "local", digest, context_length: 16384 }] }))));
    limited(req, { input: 36, cache: 12196, output: 26 });
    await expect(cliProvider(req)).rejects.toThrow(/context-exhausted/);
    const evidence = json(path.join(req.runDir, "author-process.json"));
    expect(evidence.failure).toMatchObject({ kind: "context-exhausted", inputTokens: 12232, outputTokens: 26 });
    expect(evidence.failure.nextMaxTokens).toBeUndefined();
    expect(processMock).toHaveBeenCalledTimes(1);
  });
  it("retries once in a fresh session with twice the cap and preserves evidence and totals", async () => {
    const req = recoveringRequest();
    req.session = { id: "session-original", home: path.join(req.cwd, "sessions/original") };
    req.prompt = "Delta"; req.freshPrompt = "Complete original requirements and human answers";
    const sessions: unknown[] = []; req.onSession = (id, home) => { sessions.push({ id, home }); };
    limited(req);
    respond(completed(JSON.stringify(candidate)));
    expect(await cliProvider(req)).toEqual(candidate);
    expect(processMock).toHaveBeenCalledTimes(2);
    const [first, second] = processMock.mock.calls.map(([invocation]) => invocation);
    expect(second!.env!.DSH_HOME).not.toBe(first!.env!.DSH_HOME);
    expect(second!.args).not.toContain("--session-id");
    expect(second!.input).toContain(req.freshPrompt);
    const patch = parse(readFileSync(second!.args[second!.args.indexOf("--patch") + 1]!, "utf8"));
    expect(patch.find((row: { id: string }) => row.id === "llm-pi-ai").config.providers["ollama-local"].models[0].maxTokens).toBe(1024);
    expect(sessions).toEqual([{ id: "session-corrected", home: second!.env!.DSH_HOME }]);
    const evidence = json(path.join(req.runDir, "author-process.json"));
    expect(evidence).toMatchObject({ code: -1, rawCode: 1,
      failure: { kind: "generation-exhausted", nextMaxTokens: 1024 },
      deepseek: { allocatedContextWindow: 8192, effectiveMaxTokens: 512 } });
    expect(json(path.join(req.runDir, "author-attempts.json"))).toMatchObject({
      status: "completed", kind: "token", totals: { knownTotalTokens: 640, usageComplete: true, totalTokens: 640 },
    });
    expect(json(path.join(req.runDir, "author-output.json"))).toEqual(candidate);
  });

  it.each(["disabled", "ceiling", "context", "unknown-allocation", "missing-usage", "process", "timeout", "cancelled", "stream", "session", "policy"])(
    "does not recover when %s", async failure => {
      const req = recoveringRequest();
      const token: Parameters<typeof limited>[1] = {};
      if (failure === "disabled") req.config.dsh!.tokenPolicy!.maxTokenRetries = 0;
      if (failure === "ceiling") req.config.dsh!.maxTokens = 512;
      if (failure === "context") { token.input = 7600; token.output = 26; }
      if (failure === "unknown-allocation") vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "local", digest }] }))));
      if (failure === "missing-usage") token.missingUsage = true;
      if (failure === "process") token.result = { code: 7, rawCode: 7, failureReason: "independent process failure" };
      if (failure === "timeout") token.result = { timedOut: true };
      if (failure === "cancelled") token.result = { cancelled: true };
      if (failure === "stream") token.raw = "not JSON\n";
      if (failure === "session") req.session = { id: "expected", home: path.join(req.cwd, "saved") };
      if (failure === "session") token.raw = wire([{ type: "session", sessionId: "other" }, { type: "final", sessionId: "other", reason: { kind: "max-tokens" }, text: "{}" }]);
      if (failure === "policy") token.raw = wire([{ type: "session", sessionId: "s" }, { type: "tool_call", tool: "write", callId: "w" }, { type: "final", sessionId: "s", reason: { kind: "max-tokens" }, text: "{}" }]);
      limited(req, token);
      await expect(cliProvider(req)).rejects.toThrow();
      expect(processMock).toHaveBeenCalledTimes(1);
      expect(existsSync(path.join(req.runDir, "author-output.json"))).toBe(false);
    },
  );

  it.each(["contract-then-token", "token-then-contract"])("caps %s at two attempts", async order => {
    const req = recoveringRequest();
    if (order === "contract-then-token") { respond(savedWire); limited(req); }
    else { limited(req); respond(savedWire); }
    await expect(cliProvider(req)).rejects.toThrow(/after one/);
    expect(processMock).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(req.runDir, "author-output.json"))).toBe(false);
  });

  it("shares the deadline and refuses recovery after cancellation or deadline exhaustion", async () => {
    const req = recoveringRequest();
    let now = 10000; vi.spyOn(Date, "now").mockImplementation(() => now);
    limited(req, { onRun: () => { now += 400; } });
    respond(completed(JSON.stringify(candidate)));
    await cliProvider(req);
    expect(processMock.mock.calls.map(([invocation]) => invocation.timeoutMs)).toEqual([1000, 600]);
    for (const cancel of [true, false]) {
      const next = recoveringRequest(); const controller = new AbortController(); next.signal = controller.signal;
      limited(next, { onRun: () => { if (cancel) controller.abort(); else now += next.timeoutMs; } });
      await expect(cliProvider(next)).rejects.toThrow();
    }
    expect(processMock).toHaveBeenCalledTimes(4);
  });
});
