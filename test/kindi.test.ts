import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { checkDeepSeekModel, checkDeepSeekPins, prepareDeepSeek, readDeepSeekAllocation, validateDeepSeekConfig } from "../src/deepseek.ts";
import { loadConfig } from "../src/config.ts";
import type { RoleConfig } from "../src/types.ts";

const config: RoleConfig = {
  provider: "deepseek", model: "bonsai2-9b",
  dsh: { backend: "kindi", version: "0.2.2-alpha.3", baseURL: "http://127.0.0.1:8093/v1", contextWindow: 24576, maxTokens: 8192 },
};
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
async function kindi(body: unknown = { ok: true, model: config.model, ctx: 24576 }, status = 200, redirect = false) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") {
      res.writeHead(status, redirect ? { Location: "/redirected" } : {});
      res.end(JSON.stringify(body));
    } else { res.writeHead(404); res.end("{}"); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return { config: { ...config, dsh: { ...config.dsh!, baseURL: `http://127.0.0.1:${address.port}/v1` } }, requests };
}

describe("Kindi DSH backend", () => {
  it("checks the ready model and allocated context without Ollama APIs or invented digests", async () => {
    const local = await kindi();
    const identity = await checkDeepSeekModel(local.config, 1000);
    expect(identity).toEqual({ model: "bonsai2-9b", baseURL: local.config.dsh.baseURL, contextWindow: 24576 });
    expect(await readDeepSeekAllocation(local.config, undefined, 1000)).toBe(24576);
    const loaded = loadConfig(mkdtempSync(path.join(tmpdir(), "kindi pins ")));
    loaded.providers.author = local.config;
    await expect(checkDeepSeekPins(loaded, "intent")).resolves.toBeUndefined();
    expect(local.requests).toEqual(["/health", "/health", "/health"]);
  });

  it("rejects a different model or a smaller server context before generation", async () => {
    const wrongModel = await kindi({ ok: true, model: "bonsai2-2b", ctx: 24576 });
    await expect(checkDeepSeekModel(wrongModel.config, 1000)).rejects.toThrow(/bonsai2-9b.*Kindi/);
    const tooSmall = await kindi({ ok: true, model: config.model, ctx: 8192 });
    await expect(checkDeepSeekModel(tooSmall.config, 1000)).rejects.toThrow(/smaller than configured/);
    const larger = await kindi({ ok: true, model: config.model, ctx: 32768 });
    await expect(checkDeepSeekModel(larger.config, 1000)).resolves.toMatchObject({ contextWindow: 32768 });
  });

  it.each([null, {}, { ok: false, model: config.model, ctx: 24576 }, { ok: true, model: "", ctx: 24576 }, { ok: true, model: config.model, ctx: "24576" }, { ok: true, model: config.model, ctx: -1 }])("rejects invalid health metadata %#", async body => {
    const local = await kindi(body);
    await expect(checkDeepSeekModel(local.config, 1000)).rejects.toThrow(/Invalid Kindi health/);
  });

  it("rejects HTTP errors, redirects and cancelled health checks", async () => {
    const failed = await kindi({}, 503);
    await expect(checkDeepSeekModel(failed.config, 1000)).rejects.toThrow(/Kindi health.*503/);
    const redirected = await kindi({}, 302, true);
    await expect(checkDeepSeekModel(redirected.config, 1000)).rejects.toThrow();
    expect(redirected.requests).toEqual(["/health"]);
    const controller = new AbortController(); controller.abort();
    await expect(checkDeepSeekModel(failed.config, 1000, controller.signal)).rejects.toThrow();
  });

  it("rejects unsupported backends and Ollama-only controls for Kindi", () => {
    expect(validateDeepSeekConfig(config).backend).toBe("kindi");
    for (const overrides of [{ backend: "typo" }, { thinking: false }, { expectedModelDigest: `sha256:${"a".repeat(64)}` }])
      expect(() => validateDeepSeekConfig({ ...config, dsh: { ...config.dsh!, ...overrides } } as RoleConfig)).toThrow(/configuration|Kindi/);
  });

  it("routes the guarded harness through chat completions with no automatic retries", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kindi overlay "));
    const invocation = prepareDeepSeek({ station: "spec", role: "author", prompt: "Test", cwd: root, runDir: root, config: { ...config, dsh: { ...config.dsh!, streamIdleTimeoutMs: 3600000 } }, timeoutMs: 3600000 }, {});
    const rows = parse(readFileSync(invocation.overlayFile, "utf8"));
    const providers = rows.find((row: { id: string }) => row.id === "llm-pi-ai").config.providers;
    expect(Object.keys(providers)).toEqual(["kindi-local"]);
    expect(providers["kindi-local"]).toMatchObject({ api: "openai-completions", baseURL: config.dsh!.baseURL, apiKeyEnv: "KITCHEN_KINDI_API_KEY", streamIdleTimeoutMs: 3600000, retryPolicy: { maxRetries: 0 }, models: [{ id: config.model, contextWindow: 24576, maxTokens: 8192 }] });
    expect(rows.find((row: { id: string }) => row.id === "agent-default-model").config).toEqual({ provider: "kindi-local", model: config.model });
    expect(invocation.env).toMatchObject({ KITCHEN_KINDI_API_KEY: process.env.KITCHEN_KINDI_API_KEY ?? "none" });
    expect(invocation.args).toContain("read-only");
  });
});
