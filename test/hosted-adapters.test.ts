import { describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostedProvider, probeProvider } from "../src/providers.ts";
import type { ProviderMetrics } from "../src/types.ts";

function executable(probe = false, behavior = "", response?: unknown) {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen fake provider "));
  const script = path.join(root, "provider.mjs");
  writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      "let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;",
      behavior,
      "const schemaIndex=process.argv.indexOf('--output-schema');",
      "const schema=JSON.parse(schemaIndex>=0?fs.readFileSync(process.argv[schemaIndex+1],'utf8'):process.argv[process.argv.indexOf('--json-schema')+1]);",
      `const summary=${probe ? '"Kitchen model probe OK"' : "prompt"};`,
      `const output=${response === undefined ? "schema.properties.questions?{summary,questions:[],document:null,files:[],allowedPaths:[],unitTestFiles:[],scaffoldFiles:[],checks:[]}:schema.properties.evidence?{summary,evidence:[],unresolved:[]}:{summary,findings:[]}" : JSON.stringify(response)};`,
      "fs.writeFileSync(new URL('invocation.json', import.meta.url), JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),prompt}));",
      "const index=process.argv.indexOf('--output-last-message');",
      "if(index>=0) { fs.writeFileSync(process.argv[index+1],JSON.stringify(output)); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:4}})); }",
      "else console.log(JSON.stringify({structured_output:output,is_error:false,total_cost_usd:0.01}));",
    ].join("\n"),
  );
  const file = path.join(
    root,
    process.platform === "win32" ? "fake.cmd" : "fake",
  );
  writeFileSync(
    file,
    process.platform === "win32"
      ? '@echo off\r\n"' + process.execPath + '" "' + script + '" %*\r\n'
      : '#!/bin/sh\nexec "' + process.execPath + '" "' + script + '" "$@"\n',
  );
  if (process.platform !== "win32") chmodSync(file, 0o755);
  return { root, file };
}
describe("hosted CLI adapters with fake executables", () => {
  it.runIf(process.platform === "win32")("starts the nested Codex CLI with the standalone read-only sandbox", async () => {
    vi.stubEnv("CODEX_WINDOWS_REGISTERED_CORE", "1");
    try {
      const { root, file } = executable(false, "if ('CODEX_WINDOWS_REGISTERED_CORE' in process.env) process.exit(12);");
      await hostedProvider({ station: "implementation", role: "author", prompt: "Propose a change", cwd: root,
        runDir: path.join(root, "run"), timeoutMs: 10000,
        config: { provider: "codex", executable: file, windowsSandbox: "unelevated" } });
      const { args } = JSON.parse(readFileSync(path.join(root, "invocation.json"), "utf8"));
      expect(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
      expect(args).toContain('windows.sandbox="unelevated"');
      expect(args).not.toContain("shell_tool");
      expect(process.env.CODEX_WINDOWS_REGISTERED_CORE).toBe("1");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each(["codex", "claude"] as const)("uses the intent schema and disables %s exploration tools", async (provider) => {
    const response = {
      summary: "Intent", questions: [], document: "# Intent\nCustomers need an answer.",
      files: [], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [],
    };
    const { root, file } = executable(false, "", response);
    const runDir = path.join(root, "intent");
    expect(await hostedProvider({ station: "intent", role: "author", prompt: "Capture intent", cwd: root, runDir, timeoutMs: 10000, config: { provider, executable: file } })).toEqual(response);
    const invocation = JSON.parse(readFileSync(path.join(root, "invocation.json"), "utf8"));
    const schema = JSON.parse(readFileSync(path.join(runDir, "author-schema.json"), "utf8"));
    expect(schema.properties.files.maxItems).toBe(0);
    expect(schema.anyOf).toBeUndefined();
    expect(schema.properties.document.anyOf).toEqual([
      { type: "string", pattern: "\\S" }, { type: "null" },
    ]);
    if (provider === "claude")
      expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("");
    else {
      expect(invocation.args.join(" ")).toContain("--disable shell_tool");
      expect(invocation.args.join(" ")).toContain("--disable view_image");
    }
  });
  it.each(["author", "discovery"] as const)("probes Claude's %s contract in isolation", async (contract) => {
    const { root, file } = executable(true);
    const runDir = path.join(root, "probe");
    await probeProvider({ provider: "claude", executable: file }, runDir, 10000, undefined, contract);
    const invocation = JSON.parse(readFileSync(path.join(root, "invocation.json"), "utf8"));
    const schema = JSON.parse(invocation.args[invocation.args.indexOf("--json-schema") + 1]);
    expect(schema.required).toContain(contract === "author" ? "questions" : "evidence");
    expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("");
    expect(path.relative(root, invocation.cwd).startsWith("..")).toBe(true);
    expect(existsSync(path.join(runDir, "author-process.json"))).toBe(true);
  });

  it.each([false, true])("accepts complete Claude author proposals and questions (questions=%s)", async (questions) => {
    const response = {
      summary: "Candidate", questions: questions ? [{ id: "scope", text: "Which users?" }] : [],
      document: null,
      files: questions ? [] : [
        { path: "src/a.ts", action: "write", content: "export const a = 42;\n", kind: "implementation" },
        { path: "src/b.ts", action: "write", content: "export { a } from './a';\n", kind: "implementation" },
      ], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [],
    };
    const { root, file } = executable(false, "", response);
    const prompt = "Author\n$() & literal text";
    const result = await hostedProvider({ station: "implementation", role: "author", prompt, cwd: root, runDir: path.join(root, "run"), timeoutMs: 10000, config: { provider: "claude", executable: file, model: "model & literal" } });
    expect(result).toEqual(response);
    const invocation = JSON.parse(readFileSync(path.join(root, "invocation.json"), "utf8"));
    expect(invocation.prompt).toBe(prompt);
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("model & literal");
    expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(invocation.args).toEqual(expect.arrayContaining(["--safe-mode", "dontAsk", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]));
    expect(JSON.parse(invocation.args[invocation.args.indexOf("--settings") + 1])).toEqual({ disableAllHooks: true });
    expect(JSON.parse(invocation.args[invocation.args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} });
  });

  it.each(["codex", "claude"] as const)("enforces document contracts through the %s adapter", async (provider) => {
    for (const station of ["spec", "plan", "test-plan"] as const) {
      const document = {
        summary: "Document candidate", questions: [], document: `# ${station}\nComplete document.`,
        files: [], allowedPaths: station === "plan" ? ["src/a.ts"] : [],
        unitTestFiles: station === "test-plan" ? ["src/a.test.ts"] : [], scaffoldFiles: [], checks: [],
      };
      const { root, file } = executable(false, "", document);
      const req = { station, role: "author" as const, prompt: "Author document", cwd: root,
        runDir: path.join(root, "run"), timeoutMs: 10000, config: { provider, executable: file } };
      expect(await hostedProvider(req)).toEqual(document);
      const schema = JSON.parse(readFileSync(path.join(req.runDir, "author-schema.json"), "utf8"));
      expect(schema.properties.files.maxItems).toBe(0);
      expect(schema.anyOf).toBeUndefined();
      for (const invalid of [
        { ...document, document: null },
        { ...document, document: " \n\t" },
        { ...document, files: [{ path: "src/a.ts", action: "write", content: "export const a = 42;", kind: "implementation" }] },
      ]) {
        const bad = executable(false, "", invalid);
        const runDir = path.join(bad.root, "run");
        await expect(hostedProvider({ ...req, cwd: bad.root, runDir,
          config: { provider, executable: bad.file } })).rejects.toThrow(`Invalid ${station} author output`);
        expect(JSON.parse(readFileSync(path.join(runDir, "author-process.json"), "utf8")))
          .toHaveProperty("validationError", expect.stringContaining(`Invalid ${station} author output`));
        expect(existsSync(path.join(runDir, "author-output.json"))).toBe(false);
      }
    }
  });

  it.each(["codex", "claude"] as const)("uses a read-only verify schema through the %s adapter", async (provider) => {
    const response = {
      summary: "Reviewed candidate and runner evidence.", questions: [], document: null,
      files: [], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [],
    };
    const { root, file } = executable(false, "", response);
    const req = { station: "verify" as const, role: "author" as const, prompt: "Verify candidate", cwd: root,
      runDir: path.join(root, "run"), timeoutMs: 10000, config: { provider, executable: file } };
    expect(await hostedProvider(req)).toEqual(response);
    const schema = JSON.parse(readFileSync(path.join(req.runDir, "author-schema.json"), "utf8"));
    expect(schema.properties.document).toMatchObject({ type: "null" });
    for (const key of ["files", "allowedPaths", "unitTestFiles", "scaffoldFiles", "checks"])
      expect(schema.properties[key].maxItems).toBe(0);
    expect(schema.anyOf).toBeUndefined();
    const bad = executable(false, "", { ...response, document: "# Verification report" });
    const runDir = path.join(bad.root, "run");
    await expect(hostedProvider({ ...req, cwd: bad.root, runDir,
      config: { provider, executable: bad.file } })).rejects.toThrow("Invalid verify author output");
    expect(existsSync(path.join(runDir, "author-output.json"))).toBe(false);
  });

  it("accepts Claude discovery citations through the executable boundary", async () => {
    const response = { summary: "Source", evidence: [{ path: "src/a.ts", line: 2, hash: "" }], unresolved: [] };
    const { root, file } = executable(false, "", response);
    expect(await hostedProvider({ station: "plan", role: "author", kind: "discovery", prompt: "Discover", cwd: root, runDir: path.join(root, "run"), timeoutMs: 10000, config: { provider: "claude", executable: file } })).toEqual(response);
  });

  it("retains reported spend and usage when a paid response fails validation", async () => {
    const { root, file } = executable(false, `console.log(JSON.stringify({
      structured_output: { unexpected: true }, is_error: false, total_cost_usd: 0.01,
      usage: { input_tokens: 12, output_tokens: 4 }
    })); process.exit(0);`);
    const attempts: ProviderMetrics[] = [];
    await expect(hostedProvider({ station: "plan", role: "author", prompt: "Plan", cwd: root,
      runDir: path.join(root, "run"), timeoutMs: 10000, config: { provider: "claude", executable: file },
      onMetrics: value => attempts.push(value),
    })).rejects.toThrow("Invalid plan author output");
    expect(attempts).toEqual([expect.objectContaining({ reportedCostUsd: 0.01, usage: { input_tokens: 12, output_tokens: 4 } })]);
  });

  it.each(["codex", "claude"] as const)("uses the analysis-only contract for %s specialists", async (provider) => {
    const { root, file } = executable();
    const runDir = path.join(root, "specialist");
    expect(await hostedProvider({ station: "verify", role: "author", kind: "specialist", prompt: "Inspect behavior", cwd: root, runDir, timeoutMs: 10000, config: { provider, executable: file } })).toEqual({
      summary: "Inspect behavior", evidence: [], unresolved: [],
    });
    const schema = JSON.parse(readFileSync(path.join(runDir, "author-schema.json"), "utf8"));
    expect(schema.required).toEqual(["summary", "evidence", "unresolved"]);
  });

  it.each(["codex", "claude"] as const)("uses the narrow file proposal contract for %s workers", async (provider) => {
    const response = { summary: "Draft test", questions: [], files: [{ path: "answer.test.ts", content: "test", action: "write", kind: "test" }] };
    const { root, file } = executable(false, "", response);
    const runDir = path.join(root, "proposal");
    expect(await hostedProvider({ station: "unit-tests", role: "author", kind: "proposal", prompt: "Draft tests", cwd: root, runDir, timeoutMs: 10000, config: { provider, executable: file } })).toEqual(response);
    expect(JSON.parse(readFileSync(path.join(runDir, "author-schema.json"), "utf8")).required).toEqual(["summary", "questions", "files"]);
  });

  it.each(["codex", "claude"] as const)("disables exploration in an explicitly supplied-context %s request", async (provider) => {
    const { root, file } = executable();
    await hostedProvider({ station: "plan", kind: "discovery", role: "author", noTools: true,
      prompt: "Use the supplied fixture text.", cwd: root, runDir: path.join(root, "run"), timeoutMs: 10000,
      config: { provider, executable: file },
      ...(provider === "codex" ? { codexReasoningEffort: "low" as const } : {}),
    });
    const invocation = JSON.parse(readFileSync(path.join(root, "invocation.json"), "utf8"));
    if (provider === "claude") expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("");
    else {
      expect(invocation.args.join(" ")).toContain("--disable shell_tool");
      expect(invocation.args.join(" ")).toMatch(/model_reasoning_effort=.*low/);
    }
  });

  it.each(["review-shaped", "invalid-json", "permission", "error", "timeout", "cancelled"])("retains evidence for Claude author %s failures", async (failure) => {
    const behavior = failure === "timeout" || failure === "cancelled"
      ? "await new Promise(()=>{setInterval(()=>{},1000)});"
      : failure === "invalid-json" ? "console.log('not JSON'); process.exit(0);"
      : failure === "permission" ? "console.log(JSON.stringify({structured_output:{},permission_denials:[{tool_name:'Read'}]})); process.exit(0);"
      : failure === "error" ? "console.log(JSON.stringify({is_error:true,result:'access denied'})); process.exit(1);" : "";
    const { root, file } = executable(false, behavior, { summary: "Review", findings: [] });
    const runDir = path.join(root, "run");
    const controller = new AbortController();
    const timer = failure === "cancelled" ? setTimeout(() => controller.abort(), 150) : undefined;
    try {
      await expect(hostedProvider({ station: "intent", role: "author", prompt: "Author", cwd: root, runDir, timeoutMs: failure === "timeout" ? 150 : 10000, signal: controller.signal, config: { provider: "claude", executable: file } })).rejects.toThrow();
      const evidence = JSON.parse(readFileSync(path.join(runDir, "author-process.json"), "utf8"));
      expect(evidence.provider).toBe("claude");
      expect(evidence.timedOut).toBe(failure === "timeout");
      expect(evidence.cancelled).toBe(failure === "cancelled");
      expect(existsSync(path.join(runDir, "author-prompt.txt"))).toBe(true);
      expect(existsSync(path.join(runDir, "author-output.json"))).toBe(false);
    } finally { clearTimeout(timer); }
  });

  it("persists events and reports progress before the provider finishes", async () => {
    const { root, file } = executable(
      false,
      `
      process.stdout.write('{"type":"item.star');
      await new Promise(resolve => setTimeout(resolve, 50));
      console.log('ted","item":{"type":"command_execution","command":"read repository"}}');
      await new Promise(resolve => setTimeout(resolve, 200));
    `,
    );
    const runDir = path.join(root, "run");
    const progress: string[] = [];
    let liveEvidence = false;
    await hostedProvider({
      station: "intent",
      role: "review",
      prompt: "review",
      cwd: root,
      runDir,
      timeoutMs: 10000,
      config: { provider: "codex", executable: file },
      onProgress(message) {
        progress.push(message);
        if (message.includes("read repository")) {
          liveEvidence = !existsSync(path.join(runDir, "review-answer.json"));
          expect(
            readFileSync(path.join(runDir, "review-events.jsonl"), "utf8"),
          ).toContain('"type":"item.started"');
        }
      },
    });
    expect(liveEvidence).toBe(true);
    expect(progress.join("\n")).toContain("read repository");
  });
  it.each(["tool", "stderr", "stderr-no-newline"])(
    "stops on a %s sandbox failure and preserves its classification",
    async (channel) => {
      const message =
        "Failed to create unified exec process: helper_unknown_error: setup refresh had errors";
      const behavior =
        channel === "tool"
          ? `console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'read',status:'failed',exit_code:-1,aggregated_output:${JSON.stringify(message)}}}));`
          : `process.stderr.write('ERROR codex_core::tools: exec_command tool error: setup refresh '); await new Promise(resolve=>setTimeout(resolve,50)); process.stderr.write(${JSON.stringify(channel === "stderr" ? "had errors\n" : "had errors")});`;
      const { root, file } = executable(
        false,
        behavior + "await new Promise(()=>{setInterval(()=>{},1000)});",
      );
      const runDir = path.join(root, "run");
      await expect(
        hostedProvider({
          station: "intent",
          role: "review",
          prompt: "review",
          cwd: root,
          runDir,
          timeoutMs: 4000,
          config: { provider: "codex", executable: file },
        }),
      ).rejects.toThrow(/infrastructure failure.*setup refresh/);
      const result = JSON.parse(
        readFileSync(path.join(runDir, "review-process.json"), "utf8"),
      );
      expect(result.cancelled).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.failureReason).toContain("setup refresh had errors");
      expect(
        readFileSync(
          path.join(
            runDir,
            channel === "tool" ? "review-events.jsonl" : "review-stderr.log",
          ),
          "utf8",
        ),
      ).toContain("setup refresh had errors");
    },
  );
  it("allows ordinary tool failures and ignores quoted sandbox errors in agent prose", async () => {
    const { root, file } = executable(
      false,
      `
      console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'rg',status:'failed',exit_code:1,aggregated_output:'rg not found'}}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'The docs mention setup refresh had errors'}}));
    `,
    );
    const output = await hostedProvider({
      station: "intent",
      role: "review",
      prompt: "review",
      cwd: root,
      runDir: path.join(root, "run"),
      timeoutMs: 10000,
      config: { provider: "codex", executable: file },
    });
    expect(output).toEqual({ summary: "review", findings: [] });
  });
  it.each(["codex", "claude"] as const)(
    "executes an isolated %s model probe with literal model arguments",
    async (provider) => {
      const { root, file } = executable(true);
      const runDir = path.join(root, "probe directory with spaces");
      const model = "model & literal";
      await probeProvider({ provider, model, executable: file }, runDir, 10000);
      const invocation = JSON.parse(
        readFileSync(path.join(root, "invocation.json"), "utf8"),
      );
      expect(path.relative(root, invocation.cwd).startsWith("..")).toBe(true);
      expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe(
        model,
      );
      if (provider === "claude")
        expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe(
          "",
        );
      expect(
        readFileSync(path.join(runDir, "review-process.json"), "utf8"),
      ).toContain('"code": 0');
    },
  );
  it.each(["codex", "claude"] as const)(
    "captures %s structured results and available usage metadata",
    async (provider) => {
      const { root, file } = executable();
      const runDir = path.join(root, "run");
      const output = await hostedProvider({
        station: "intent",
        role: "review",
        prompt: "A prompt\nwith $() & literal text",
        cwd: root,
        runDir,
        timeoutMs: 10000,
        config: {
          provider,
          executable: file,
          ...(provider === "codex"
            ? { windowsSandbox: "unelevated" as const }
            : {}),
        },
      });
      expect(output).toEqual({
        summary: "A prompt\nwith $() & literal text",
        findings: [],
      });
      expect(
        readFileSync(path.join(runDir, "review-process.json"), "utf8"),
      ).toContain(provider === "codex" ? "input_tokens" : "total_cost_usd");
      if (provider === "codex") {
        const invocation = JSON.parse(
          readFileSync(path.join(root, "invocation.json"), "utf8"),
        );
        expect(invocation.args).toContain('windows.sandbox="unelevated"');
        const evidence = JSON.parse(
          readFileSync(path.join(runDir, "review-process.json"), "utf8"),
        );
        expect(evidence.windowsSandbox).toBe("unelevated");
      }
    },
  );
});
