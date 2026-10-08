import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostedProvider } from "../src/providers.ts";

function executable() {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen fake provider "));
  const script = path.join(root, "provider.mjs");
  writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      "let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;",
      "const output={summary:prompt,findings:[]};",
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
        config: { provider, executable: file },
      });
      expect(output).toEqual({
        summary: "A prompt\nwith $() & literal text",
        findings: [],
      });
      expect(
        readFileSync(path.join(runDir, "review-process.json"), "utf8"),
      ).toContain(provider === "codex" ? "input_tokens" : "total_cost_usd");
    },
  );
});
