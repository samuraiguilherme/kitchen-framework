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
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    let body = "";
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    assert.equal(request.max_tokens, expectedCap);
    wireRequests.push(request);
    writeFileSync(path.join(root, "wire-requests.json"), JSON.stringify(wireRequests, null, 2));
    assert.deepEqual(
      (request.tools ?? [])
        .map((tool: { function: { name: string } }) => tool.function.name)
        .sort(),
      mode === "probe" ? [] : ["glob", "grep", "read"],
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
              content: JSON.stringify({
                summary:
                  mode === "probe" ? "Kitchen model probe OK" : "DSH smoke OK",
                findings: [],
              }),
            };
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion.chunk", model: "kitchen-smoke", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: mode === "truncate" ? "length" : first || mode === "deny" ? "tool_calls" : "stop" }], ...(mode === "no-usage" ? {} : { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) })}\n\n`,
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
    station: "intent",
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
  mode = "probe";
  const capped = { ...config, dsh: { ...config.dsh, tokenPolicy: { version: 1 as const, outputTokens: { probe: 256, review: 512 } } } };
  expectedCap = 256;
  await probeProvider(capped, path.join(root, "probe"), 60000);
  expectedCap = 2048;
  mode = "deny";
  await assert.rejects(
    cliProvider({
      station: "intent",
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
  await assert.rejects(cliProvider({ station: "intent", role: "review", cwd: root,
    runDir: path.join(root, "truncated"), timeoutMs: 60000, prompt: "Return review JSON.", config: capped,
  }), /max-tokens|incomplete|length/i);
  const beforeOversized = requests;
  await assert.rejects(cliProvider({ station: "intent", role: "review", cwd: root,
    runDir: path.join(root, "oversized"), timeoutMs: 60000, prompt: "Required document ".repeat(1000),
    config: { ...config, dsh: { ...config.dsh, tokenPolicy: { version: 1, maxInputBytes: 256 } } },
  }), /input .* bytes exceeds/);
  assert.equal(requests, beforeOversized);
  mode = "no-usage";
  expectedCap = 2048;
  await cliProvider({ station: "intent", role: "review", cwd: root,
    runDir: path.join(root, "no-usage"), timeoutMs: 60000, prompt: "Return review JSON.", config,
  });
  const unknownUsage = JSON.parse(readFileSync(path.join(root, "no-usage/review-process.json"), "utf8"));
  assert.equal(unknownUsage.metrics.tokens.usageComplete, false);
  assert.equal(unknownUsage.metrics.tokens.totalTokens, undefined);
  assert.equal(unknownUsage.metrics.usage, undefined);
  console.log(
    `DSH ${version}: profile, read-only catalogue, file read, wire output caps, no-tools probe, forbidden-write rejection, token accounting, step/byte limits, and truncated-output rejection passed. Evidence: ${root}`,
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
