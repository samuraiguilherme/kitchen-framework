import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { executeCheck } from "../src/checks.ts";

describe("candidate browser targeting", () => {
  it("builds and targets a dedicated candidate preview while preserving another running service", async () => {
    const existing = http.createServer((_request, response) =>
      response.end("existing dev"),
    );
    await new Promise<void>((resolve) =>
      existing.listen(0, "127.0.0.1", resolve),
    );
    const address = existing.address();
    const existingUrl =
      "http://127.0.0.1:" +
      (typeof address === "object" && address ? address.port : 0);
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-browser-"));
    writeFileSync(path.join(root, "fixture.json"), "{}");
    writeFileSync(
      path.join(root, "preview.mjs"),
      "import http from 'node:http'; http.createServer((q,s)=>s.end(process.env.KITCHEN_SOURCE_FINGERPRINT)).listen(Number(process.argv[2]),'127.0.0.1');",
    );
    writeFileSync(
      path.join(root, "flow.mjs"),
      "const body=await (await fetch(process.argv[2])).text(); const passed=body==='candidate-sha'; console.log(JSON.stringify({numTotalTests:1,numPassedTests:passed?1:0,numFailedTests:passed?0:1,testResults:[{assertionResults:[{fullName:'AC-1 candidate flow',status:passed?'passed':'failed',failureMessages:passed?[]:['AssertionError: expected candidate-sha']}]}]})); process.exitCode=passed?0:1;",
    );
    try {
      const result = await executeCheck({
        root,
        runDir: path.join(root, ".kitchen/evidence"),
        fingerprint: "candidate-sha",
        green: true,
        definition: {
          id: "flow",
          profile: "browser",
          files: ["flow.mjs"],
          acIds: ["AC-1"],
          required: true,
          expectation: "green",
        },
        profile: {
          kind: "browser",
          command: process.execPath,
          args: ["flow.mjs", "{baseUrl}"],
          cwd: ".",
          parser: "vitest-json",
          timeoutMs: 10000,
          fixture: "fixture.json",
          preview: {
            command: process.execPath,
            args: ["preview.mjs", "{port}"],
            build: {
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
            },
          },
        },
      });
      expect(result).toMatchObject({
        status: "passed",
        total: 1,
        sourceFingerprint: "candidate-sha",
      });
      expect(await (await fetch(existingUrl)).text()).toBe("existing dev");
    } finally {
      await new Promise<void>((resolve) => existing.close(() => resolve()));
    }
  });
});
