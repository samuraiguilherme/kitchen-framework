import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostedProvider } from "../src/providers.ts";
import type { ProviderMetrics, ProviderName } from "../src/types.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-metrics-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function executable() {
  const root = fixture();
  const script = path.join(root, "provider.mjs");
  writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      "for await (const _chunk of process.stdin) {}",
      "const output = {summary:'Reviewed',findings:[]};",
      "const index = process.argv.indexOf('--output-last-message');",
      "if(index >= 0) { console.log(JSON.stringify({type:'thread.started'})); fs.writeFileSync(process.argv[index+1], JSON.stringify(output)); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:4}})); }",
      "else console.log(JSON.stringify({structured_output:output,is_error:false,usage:{input_tokens:3,output_tokens:4,non_numeric:'excluded'}}));",
    ].join("\n"),
  );
  const file = path.join(
    root,
    process.platform === "win32" ? "provider.cmd" : "provider",
  );
  writeFileSync(
    file,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
  );
  if (process.platform !== "win32") chmodSync(file, 0o755);
  return { root, file };
}
describe("provider process metrics", () => {
it.each<ProviderName>(["codex", "claude"])(
    "persists %s process start/finish timestamps and returns successful output timing",
    async (provider) => {
      const { root, file } = executable();
      const observed: ProviderMetrics[] = [];
      await hostedProvider({
        station: "intent",
        role: "review",
        cwd: root,
        runDir: path.join(root, "run"),
        config: { provider, executable: file },
        prompt: "review",
        timeoutMs: 10000,
        onMetrics: (metrics) => observed.push(metrics),
      });
      const processEvidence = JSON.parse(
        readFileSync(path.join(root, "run/review-process.json"), "utf8"),
      );
      expect(Number.isFinite(Date.parse(processEvidence.startedAt))).toBe(true);
      expect(Date.parse(processEvidence.finishedAt)).toBeGreaterThanOrEqual(
        Date.parse(processEvidence.startedAt),
      );
      expect(processEvidence.metrics.durationMs).toBeGreaterThanOrEqual(0);
      expect(observed).toHaveLength(1);
      expect(observed[0]!.actionableOutputMs).toBeGreaterThanOrEqual(0);
      expect(observed[0]!.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
      if (provider === "claude")
        expect(observed[0]!.firstToolMs).toBeUndefined();
    },
  );
});
