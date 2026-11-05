// Explicit integration check against an already cached DSH release. The model
// endpoint is a local protocol fixture; no Ollama install or paid model is used.
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { cliProvider, probeProvider } from "../src/providers.ts";

const version = process.argv[2] ?? "0.2.2-alpha.3";
const root = mkdtempSync(path.join(tmpdir(), "kitchen-dsh-smoke-"));
const marker = "KITCHEN_DSH_READ_CONFIRMED";
const intent = {
  summary: "DSH intent OK", questions: [], document: "# Intent\nCustomers need a clearer notice.",
  files: [], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [],
};
writeFileSync(path.join(root, "proof.txt"), marker);
let requests = 0;
let mode = "read";
let taskRequests = 0;
const wireRequests: unknown[] = [];
let expectedCap = 2048;
const server = createServer(async (req, res) => {
  if (req.url === "/api/tags") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        models: [{ name: "kitchen-smoke", digest: "a".repeat(64) }],
      }),
    );
    return;
  }
  if (req.url === "/api/ps") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ models: [{ name: "kitchen-smoke", digest: "a".repeat(64), context_length: 8192 }] }));
    return;
  }
  if (req.url === "/api/show") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ thinking: { values: [false, true], default: true } }));
    return;
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    let body = "";
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    if (mode === "recover") expectedCap = taskRequests++ === 0 ? 512 : 1024;
    assert.equal(request.max_tokens, expectedCap);
    if (mode === "thinking") assert.equal(request.reasoning_effort, "none");
    wireRequests.push(request);
    writeFileSync(path.join(root, "wire-requests.json"), JSON.stringify(wireRequests, null, 2));
    assert.deepEqual(
      (request.tools ?? [])
        .map((tool: { function: { name: string } }) => tool.function.name)
        .sort(),
      ["probe", "intent"].includes(mode) ? [] : ["glob", "grep", "read"],
    );
    requests++;
    const first = ["read", "loop"].includes(mode) && taskRequests++ === 0;
    if (mode === "read" && !first)
      assert.ok(
        request.messages.some(
          (message: { role: string; content: string }) =>
            message.role === "tool" && message.content.includes(marker),
        ),
      );
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "idle") {
      res.flushHeaders();
      const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 5000);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    const delta =
      mode === "deny"
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "denied-write",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({
                    file_path: "should-not-exist.txt",
                    content: "forbidden",
                  }),
                },
              },
            ],
          }
        : first
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "read-proof",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ file_path: "proof.txt" }),
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content: JSON.stringify(mode === "intent" ? intent : {
                summary:
                  mode === "probe" ? "Kitchen model probe OK" : "DSH smoke OK",
                findings: [],
              }),
            };
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion.chunk", model: "kitchen-smoke", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: mode === "truncate" || (mode === "recover" && expectedCap === 512) ? "length" : first || mode === "deny" ? "tool_calls" : "stop" }], ...(mode === "no-usage" ? {} : { usage: { prompt_tokens: 10, completion_tokens: mode === "recover" ? expectedCap : 10, total_tokens: 10 + (mode === "recover" ? expectedCap : 10) } }) })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    provider: "deepseek" as const,
    model: "kitchen-smoke",
    dsh: {
      version,
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      contextWindow: 8192,
      maxTokens: 2048,
    },
  };
  const output = await cliProvider({
    station: "spec",
    role: "review",
    cwd: root,
    runDir: path.join(root, "run"),
    timeoutMs: 60000,
    prompt:
      "Read proof.txt, then return the required review JSON with summary DSH smoke OK and no findings.",
    config,
    onProgress: (message) => console.log(message),
  });
  assert.deepEqual(output, { summary: "DSH smoke OK", findings: [] });
  assert.equal(requests, 2);
  const evidence = JSON.parse(
    readFileSync(path.join(root, "run/review-process.json"), "utf8"),
  );
  assert.equal(evidence.metrics.toolCount, 1);
  assert.equal(evidence.metrics.tokens.modelSteps, 2);
  assert.equal(evidence.metrics.tokens.usageComplete, true);
  assert.equal(evidence.metrics.tokens.totalTokens, 40);
  assert.equal(evidence.metrics.tokens.adapterInputBytes, Buffer.byteLength(readFileSync(path.join(root, "run/review-prompt.txt"), "utf8")));
  assert.ok(evidence.metrics.tokens.adapterInputBytes > evidence.metrics.tokens.kitchenPromptBytes);
  assert.ok(evidence.metrics.tokens.steps[0].sectionBytes.tools > 0);
  assert.ok(evidence.metrics.tokens.toolResultBytes > 0);
  mode = "intent";
  assert.deepEqual(await cliProvider({
    station: "intent", role: "author", cwd: root, runDir: path.join(root, "intent"),
    timeoutMs: 60000, prompt: "Capture product intent using only supplied context.", config,
  }), intent);
  const intentEvidence = JSON.parse(readFileSync(path.join(root, "intent/author-process.json"), "utf8"));
  assert.equal(intentEvidence.metrics.toolCount, 0);
  assert.equal(intentEvidence.metrics.tokens.modelSteps, 1);
  mode = "probe";
  const capped = { ...config, dsh: { ...config.dsh, tokenPolicy: { version: 1 as const, outputTokens: { probe: 256, review: 512 } } } };
  expectedCap = 256;
  await probeProvider(capped, path.join(root, "probe"), 60000);
  expectedCap = 2048;
  mode = "deny";
  await assert.rejects(
    cliProvider({
      station: "spec",
      role: "review",
      cwd: root,
      runDir: path.join(root, "denied"),
      timeoutMs: 60000,
      prompt: "Attempt a write.",
      config,
    }),
    /KITCHEN_TOOL_DENIED/,
  );
  assert.equal(existsSync(path.join(root, "should-not-exist.txt")), false);
  mode = "loop";
  taskRequests = 0;
  const beforeLoop = requests;
  await assert.rejects(cliProvider({ station: "plan", role: "review", cwd: root,
    runDir: path.join(root, "loop"), timeoutMs: 60000, prompt: "Read proof.txt.",
    config: { ...config, dsh: { ...config.dsh, tokenPolicy: { version: 1, maxSteps: 1 } } },
  }), /model-step limit/);
  assert.equal(requests - beforeLoop, 1);
  mode = "truncate";
  expectedCap = 512;
  await assert.rejects(cliProvider({ station: "spec", role: "review", cwd: root,
    runDir: path.join(root, "truncated"), timeoutMs: 60000, prompt: "Return review JSON.", config: capped,
  }), /max-tokens|incomplete|length/i);
  const beforeOversized = requests;
  await assert.rejects(cliProvider({ station: "spec", role: "review", cwd: root,
    runDir: path.join(root, "oversized"), timeoutMs: 60000, prompt: "Required document ".repeat(1000),
    config: { ...config, dsh: { ...config.dsh, tokenPolicy: { version: 1, maxInputBytes: 256 } } },
  }), /input .* bytes exceeds/);
  assert.equal(requests, beforeOversized);
  mode = "no-usage";
  expectedCap = 2048;
  await cliProvider({ station: "spec", role: "review", cwd: root,
    runDir: path.join(root, "no-usage"), timeoutMs: 60000, prompt: "Return review JSON.", config,
  });
  const unknownUsage = JSON.parse(readFileSync(path.join(root, "no-usage/review-process.json"), "utf8"));
  assert.equal(unknownUsage.metrics.tokens.usageComplete, false);
  assert.equal(unknownUsage.metrics.tokens.totalTokens, undefined);
  assert.equal(unknownUsage.metrics.usage, undefined);
  mode = "recover";
  taskRequests = 0;
  const recovered = await cliProvider({ station: "spec", role: "review", cwd: root,
    runDir: path.join(root, "recovered"), timeoutMs: 60000, prompt: "Return complete review JSON.",
    config: { ...config, dsh: { ...config.dsh, streamIdleTimeoutMs: 1500,
      tokenPolicy: { version: 1, maxTokenRetries: 1, outputTokens: { review: 512 } } } },
  });
  assert.deepEqual(recovered, { summary: "DSH smoke OK", findings: [] });
  assert.equal(taskRequests, 2);
  const recovery = JSON.parse(readFileSync(path.join(root, "recovered/review-attempts.json"), "utf8"));
  assert.equal(recovery.kind, "token");
  assert.equal(recovery.status, "completed");
  assert.equal(recovery.totals.totalTokens, 1556);
  const limited = JSON.parse(readFileSync(path.join(root, "recovered/review-process.json"), "utf8"));
  assert.equal(limited.rawCode, 1);
  assert.equal(limited.failure.kind, "generation-exhausted");
  assert.equal(limited.deepseek.effectiveStreamIdleTimeoutMs, 1500);
  mode = "idle";
  expectedCap = 2048;
  const beforeIdle = requests;
  await assert.rejects(cliProvider({ station: "spec", role: "review", cwd: root,
    runDir: path.join(root, "idle"), timeoutMs: 60000, prompt: "Return complete review JSON.",
    config: { ...config, dsh: { ...config.dsh, streamIdleTimeoutMs: 2000,
      tokenPolicy: { version: 1, maxTokenRetries: 1, outputTokens: { review: 2048 } } } },
  }), /stream idle timeout|stream-idle-timeout/i);
  assert.equal(requests - beforeIdle, 1);
  mode = "thinking";
  await cliProvider({ station: "spec", role: "review", cwd: root,
    runDir: path.join(root, "thinking-off"), timeoutMs: 60000, prompt: "Return complete review JSON.",
    config: { ...config, dsh: { ...config.dsh, thinking: false } },
  });
  console.log(
    `DSH ${version}: profile, read-only catalogue, file read, no-tools intent, wire output caps, no-tools probe, forbidden-write rejection, token accounting, step/byte limits, truncated-output rejection, idle watchdog configuration, and bounded token recovery passed. Evidence: ${root}`,
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
