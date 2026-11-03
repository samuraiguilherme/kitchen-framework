import { describe, expect, it } from "vitest";
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
      document: questions ? null : "# Plan\nComplete document\n",
      files: questions ? [] : [
        { path: "src/a.ts", action: "write", content: "export const a = 42;\n", kind: "implementation" },
        { path: "src/b.ts", action: "write", content: "export { a } from './a';\n", kind: "implementation" },
      ], allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [],
    };
    const { root, file } = executable(false, "", response);
    const prompt = "Author\n$() & literal text";
    const result = await hostedProvider({ station: "plan", role: "author", prompt, cwd: root, runDir: path.join(root, "run"), timeoutMs: 10000, config: { provider: "claude", executable: file, model: "model & literal" } });
    expect(result).toEqual(response);
    const invocation = JSON.parse(readFileSync(path.join(root, "invocation.json"), "utf8"));
    expect(invocation.prompt).toBe(prompt);
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("model & literal");
    expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(invocation.args).toEqual(expect.arrayContaining(["--safe-mode", "dontAsk", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]));
    expect(JSON.parse(invocation.args[invocation.args.indexOf("--settings") + 1])).toEqual({ disableAllHooks: true });
    expect(JSON.parse(invocation.args[invocation.args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} });
  });

  it("accepts Claude discovery citations through the executable boundary", async () => {
    const response = { summary: "Source", evidence: [{ path: "src/a.ts", line: 2, hash: "" }], unresolved: [] };
    const { root, file } = executable(false, "", response);
    expect(await hostedProvider({ station: "plan", role: "author", kind: "discovery", prompt: "Discover", cwd: root, runDir: path.join(root, "run"), timeoutMs: 10000, config: { provider: "claude", executable: file } })).toEqual(response);
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
