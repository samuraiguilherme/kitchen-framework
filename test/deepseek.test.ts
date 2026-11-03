import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { parse } from "yaml";
import {
  checkDeepSeekModel,
  checkDeepSeekPins,
  parseDeepSeekOutput,
  prepareDeepSeek,
} from "../src/deepseek.ts";
import { cliProvider, probeProvider } from "../src/providers.ts";
import type { ProviderRequest, RoleConfig } from "../src/types.ts";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { providerProgress } from "../src/provider-progress.ts";
import { mkdirSync } from "node:fs";

const digest = `sha256:${"a".repeat(64)}`;
const review = { summary: "Kitchen model probe OK", findings: [] };
const config: RoleConfig = {
  provider: "deepseek",
  model: "kitchen-deepseek-r1:8b",
  dsh: {
    version: "0.2.2-alpha.3",
    baseURL: "http://127.0.0.1:11434/v1",
    contextWindow: 8192,
    maxTokens: 2048,
    expectedModelDigest: digest,
  },
};
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function transcript(value: unknown = review) {
  return [
    { type: "session", sessionId: "session-test" },
    { type: "text", text: "untrusted partial", truncated: true },
    {
      type: "final",
      sessionId: "session-test",
      reason: { kind: "completed" },
      text: JSON.stringify(value),
    },
  ];
}
const ndjson = (events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");
function request(): ProviderRequest {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen dsh "));
  return {
    station: "intent",
    role: "review",
    prompt: 'Literal $() & "prompt"\nnext line',
    cwd: root,
    runDir: path.join(root, "run evidence"),
    timeoutMs: 5000,
    config,
  };
}
async function ollama(
  models = [{ name: config.model, digest: digest.slice(7) }],
) {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags") res.end(JSON.stringify({ models }));
    else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  return {
    ...config,
    dsh: { ...config.dsh!, baseURL: `http://127.0.0.1:${address.port}/v1` },
  };
}

describe("DeepSeek headless contract", () => {
  it("uses the lossless final answer, including answers above the text-event cap", () => {
    const output = { ...review, summary: "x".repeat(20000) };
    expect(parseDeepSeekOutput(ndjson(transcript(output)))).toEqual(output);
  });
  it.each(
    [
      [],
      transcript().slice(0, -1),
      [...transcript(), transcript()[2]],
      [transcript()[0], { ...transcript()[2], sessionId: "another-session" }],
      [transcript()[0], { ...transcript()[2], reason: null }],
      [transcript()[0], { ...transcript()[2], reason: { kind: "error" } }],
      [
        transcript()[0],
        { type: "error", message: "model unavailable" },
        transcript()[2],
      ],
      [
        transcript()[0],
        { type: "tool_call", callId: "write-1", tool: "write", input: {} },
        transcript()[2],
      ],
      [transcript()[0], { ...transcript()[2], text: "```json\n{}\n```" }],
      [transcript()[0], { ...transcript()[2], text: "{} extra prose" }],
      [
        transcript()[0],
        {
          type: "tool_result",
          callId: "read-1",
          status: "error",
          error: { code: "PERMISSION_DENIED" },
        },
        transcript()[2],
      ],
      [transcript()[0], { type: "unexpected-version-event" }, transcript()[2]],
    ].map((events) => ({ events })),
  )(
    "rejects incomplete, failed, denied or malformed streams %#",
    ({ events }) => {
      expect(() => parseDeepSeekOutput(ndjson(events))).toThrow();
    },
  );
  it("allows an ordinary read failure and rejects non-JSON stdout", () => {
    const events = transcript();
    events.splice(1, 0, {
      type: "tool_result",
      callId: "read-1",
      status: "error",
      error: { code: "ENOENT" },
    } as never);
    expect(parseDeepSeekOutput(ndjson(events))).toEqual(review);
    expect(() =>
      parseDeepSeekOutput("startup banner\n" + ndjson(events)),
    ).toThrow(/JSON|stream/i);
  });

  it("isolates profiles, uses stdin, and makes the guard a runner dependency", () => {
    const req = request();
    const invocation = prepareDeepSeek(req, { type: "object" });
    expect(invocation.command).toBe(
      process.platform === "win32" ? "npx.cmd" : "npx",
    );
    expect(invocation.args.slice(0, 3)).toEqual([
      "--yes",
      "--offline",
      "@deepseek-ai/dsh@0.2.2-alpha.3",
    ]);
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain("never");
    expect(invocation.args.at(-1)).toBe("-");
    expect(invocation.args).not.toContain("--model");
    expect(invocation.input).toContain(req.prompt);
    expect(invocation.input).toContain('"type":"object"');
    expect(invocation.env.DSH_HOME).toContain(req.runDir);
    expect(invocation.env.DSH_TELEMETRY_MODE).toBe("DISABLED");
    const rows = parse(readFileSync(invocation.overlayFile, "utf8"));
    expect(
      rows.find((r: { id: string }) => r.id === "tool-fs").config,
    ).toMatchObject({
      write: false,
      edit: false,
      read: true,
      readImage: false,
      applyPatch: false,
    });
    expect(
      rows.find((r: { id: string }) => r.id === "headless-runner").inject,
    ).toContain("kitchenReadOnly");
    expect(
      rows
        .flatMap((r: { insert?: unknown[] }) => r.insert ?? [])
        .find((r: { id: string }) => r.id === "kitchen-read-only").config
        .allowTools,
    ).toEqual(["read", "glob", "grep"]);
    const probe = prepareDeepSeek(
      { ...req, runDir: path.join(req.runDir, "probe") },
      {},
      true,
    );
    const probeRows = parse(readFileSync(probe.overlayFile, "utf8"));
    expect(
      probeRows
        .flatMap((r: { insert?: unknown[] }) => r.insert ?? [])
        .find((r: { id: string }) => r.id === "kitchen-read-only").config
        .allowTools,
    ).toEqual([]);
  });

  it("enforces the guard before execution even for future tool names", async () => {
    const guardModule = await import(
      new URL("../src/deepseek-guard.mjs", import.meta.url).href
    );
    let guard: (call: { name: string }) => unknown = () => {
      throw new Error("Guard not installed");
    };
    let provided = "";
    guardModule.apply(
      {
        tools: {
          guard: (fn: typeof guard) => {
            guard = fn;
          },
        },
        provide: (name: string) => {
          provided = name;
        },
      },
      { allowTools: ["read", "glob", "grep"] },
    );
    expect(provided).toBe("kitchenReadOnly");
    expect(guard({ name: "read" })).toBeUndefined();
    for (const name of [
      "write",
      "edit",
      "bash",
      "pwsh",
      "subagent",
      "web",
      "future_tool",
    ])
      expect(guard({ name })).toMatch(/KITCHEN_TOOL_DENIED/);
    expect(() =>
      guardModule.apply({ tools: {}, provide() {} }, { allowTools: [] }),
    ).toThrow();
  });

  it("checks exact local model availability and digest", async () => {
    const local = await ollama();
    expect(
      await checkDeepSeekModel(
        {
          ...local,
          dsh: { ...local.dsh!, expectedModelDigest: digest.slice(7) },
        },
        3000,
      ),
    ).toMatchObject({ digest });
    expect(await checkDeepSeekModel(local, 3000)).toMatchObject({
      digest,
      model: config.model,
    });
    await expect(
      checkDeepSeekModel({ ...local, model: "missing-model" }, 3000),
    ).rejects.toThrow(/not installed/);
    await expect(
      checkDeepSeekModel(
        {
          ...local,
          dsh: {
            ...local.dsh!,
            expectedModelDigest: `sha256:${"b".repeat(64)}`,
          },
        },
        3000,
      ),
    ).rejects.toThrow(/digest/i);
    const loaded = loadConfig(request().cwd);
    loaded.providers.author = {
      ...local,
      dsh: { ...local.dsh!, expectedModelDigest: `sha256:${"b".repeat(64)}` },
    };
    await expect(checkDeepSeekPins(loaded, "intent")).rejects.toThrow(
      /digest/i,
    );
    await expect(checkDeepSeekPins(loaded, "publish")).resolves.toBeUndefined();
  });

  it("refuses redirected model inventories and bounds unavailable servers", async () => {
    let redirected = false;
    const server = createServer((req, res) => {
      if (req.url === "/api/tags") {
        res.writeHead(302, { Location: "/other" });
        res.end();
      } else {
        redirected = true;
        res.end("{}");
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    const local = {
      ...config,
      dsh: { ...config.dsh!, baseURL: `http://127.0.0.1:${address.port}/v1` },
    };
    await expect(checkDeepSeekModel(local, 1000)).rejects.toThrow();
    expect(redirected).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(
      checkDeepSeekModel(local, 1000, controller.signal),
    ).rejects.toThrow();
  });

  it("records chunked progress, unique tool calls, and available step usage", () => {
    const req = request();
    mkdirSync(req.runDir, { recursive: true });
    const progress = providerProgress(req);
    const wire = ndjson([
      { type: "session", sessionId: "s" },
      { type: "tool_call", callId: "r", tool: "read" },
      { type: "tool_result", callId: "r", status: "completed" },
      {
        type: "status",
        phase: "step_end",
        usage: { inputTokens: 10, outputTokens: 3 },
      },
      {
        type: "status",
        phase: "step_end",
        usage: { inputTokens: 8, outputTokens: 4 },
      },
    ]);
    progress.capture("stdout", wire.slice(0, 19));
    progress.capture("stdout", wire.slice(19));
    progress.finish();
    expect(progress.metrics()).toMatchObject({
      toolCount: 1,
      usage: { inputTokens: 18, outputTokens: 7 },
    });
    expect(
      readFileSync(path.join(req.runDir, "review-events.jsonl"), "utf8"),
    ).toBe(wire);
    progress.capture("stdout", '\n{"type":"status","phase":"step_end"}\n');
    expect(progress.metrics().usage).toBeUndefined();
  });

  it("runs the real process adapter against a fake npx and local Ollama", async () => {
    const req = request();
    const local = await ollama();
    const script = path.join(req.cwd, "fake-npx.mjs");
    writeFileSync(
      script,
      [
        "import fs from 'node:fs';",
        "let input=''; for await (const part of process.stdin) input+=part;",
        "fs.writeFileSync(new URL('invocation.json', import.meta.url), JSON.stringify({args:process.argv.slice(2),input,cwd:process.cwd(),home:process.env.DSH_HOME}));",
        `const events=${JSON.stringify(transcript())};`,
        "const wire=events.map(event=>JSON.stringify(event)).join('\\n'); process.stdout.write(wire.slice(0,25)); setTimeout(()=>process.stdout.write(wire.slice(25)),20);",
      ].join("\n"),
    );
    const launcher = path.join(
      req.cwd,
      process.platform === "win32" ? "fake.cmd" : "fake",
    );
    writeFileSync(
      launcher,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      { mode: 0o755 },
    );
    const selected = { ...local, executable: launcher };
    const metrics: unknown[] = [];
    expect(
      await cliProvider({
        ...req,
        config: selected,
        onMetrics: (m) => metrics.push(m),
      }),
    ).toEqual(review);
    expect(
      JSON.parse(
        readFileSync(path.join(req.runDir, "review-process.json"), "utf8"),
      ),
    ).toMatchObject({ provider: "deepseek", deepseek: { digest }, code: 0 });
    expect(metrics).toHaveLength(1);
    await probeProvider(selected, path.join(req.runDir, "probe"), 5000);
    const invocation = JSON.parse(
      readFileSync(path.join(req.cwd, "invocation.json"), "utf8"),
    );
    expect(invocation.cwd).not.toBe(req.cwd);
    expect(invocation.input).toContain("Kitchen model probe OK");
  });
});
