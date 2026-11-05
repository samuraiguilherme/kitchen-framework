import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeCheck } from "../src/checks.ts";
import { loadConfig } from "../src/config.ts";
import { hash } from "../src/domain.ts";
import { runProcess } from "../src/process.ts";
import type { ExecuteCheckInput } from "../src/checks.ts";

vi.mock("../src/process.ts", () => ({ runProcess: vi.fn(), stopProcess: vi.fn() }));
const ok = { code: 0, stdout: "Reporter wrote the JSON file", stderr: "", timedOut: false, cancelled: false };
const report = (failed = false, padding = "") => JSON.stringify({
  success: !failed, numTotalTests: 1, numPassedTests: failed ? 0 : 1, numFailedTests: failed ? 1 : 0,
  testResults: [{ assertionResults: [{ fullName: "AC-1 renders subtitle", status: failed ? "failed" : "passed",
    failureMessages: failed ? ["AssertionError: expected old subtitle to equal new subtitle"] : [],
  }] }], padding,
});
function fixture(): ExecuteCheckInput {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-check-report-"));
  writeFileSync(path.join(root, "brand.test.ts"), "// AC-1 fixture test\n");
  return {
    root, runDir: path.join(root, ".kitchen/evidence"), fingerprint: "candidate", green: true,
    definition: { id: "unit", profile: "unit", files: ["brand.test.ts"], acIds: ["AC-1"], required: true, expectation: "red" },
    profile: { kind: "unit", command: "pnpm", args: ["exec", "vitest", "run", "{files}", "--reporter=json", "--outputFile={reportFile}"], parser: "vitest-json", timeoutMs: 1000 },
  };
}
const reportPath = (input: ExecuteCheckInput) => path.join(input.runDir, "report-unit.json");
beforeEach(() => { vi.mocked(runProcess).mockReset(); });

describe("counted report file evidence", () => {
  it("expands an isolated report path and hashes the complete report with raw execution evidence", async () => {
    const input = fixture();
    vi.mocked(runProcess).mockImplementation(async (request) => {
      expect(request.args).toContain(path.join(input.root, "brand.test.ts"));
      expect(request.args).toContain(`--outputFile=${reportPath(input)}`);
      writeFileSync(reportPath(input), report());
      return ok;
    });
    const result = await executeCheck(input);
    expect(result).toMatchObject({ status: "passed", total: 1, failed: 0 });
    expect(result.evidenceHashes?.[reportPath(input)]).toBe(hash(readFileSync(reportPath(input))));
    const raw = JSON.parse(readFileSync(path.join(input.runDir, "raw-unit.json"), "utf8"));
    expect(raw.reportFile).toBe(reportPath(input));
  });

  it("reads a complete report larger than the process-output limit", async () => {
    const input = fixture();
    vi.mocked(runProcess).mockImplementation(async () => {
      writeFileSync(reportPath(input), report(false, "x".repeat(20_000_001)));
      return ok;
    });
    expect(await executeCheck(input)).toMatchObject({ status: "passed", total: 1 });
  });

  it.each(["missing", "malformed", "oversized", "directory"])("blocks a %s artifact even when stdout claims success", async (kind) => {
    const input = fixture();
    vi.mocked(runProcess).mockImplementation(async () => {
      if (kind === "directory") mkdirSync(reportPath(input));
      else if (kind !== "missing") {
        writeFileSync(reportPath(input), kind === "malformed" ? "{partial" : "");
        if (kind === "oversized") truncateSync(reportPath(input), 128 * 1024 * 1024 + 1);
      }
      return { ...ok, stdout: report() };
    });
    const result = await executeCheck(input);
    expect(result.status).toBe("unverified");
    if (kind === "missing" || kind === "oversized" || kind === "directory")
      expect(result.evidenceHashes?.[reportPath(input)]).toBeUndefined();
  });

  it("rejects a stale artifact before starting the command", async () => {
    const input = fixture();
    mkdirSync(input.runDir, { recursive: true });
    writeFileSync(reportPath(input), report());
    expect(await executeCheck(input)).toMatchObject({ status: "unverified", reason: expect.stringContaining("fresh report artifact") });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it.each(["red", "green"] as const)("retains %s assertion and exit-status validation", async (expectation) => {
    const input = fixture();
    input.green = expectation === "green";
    vi.mocked(runProcess).mockImplementation(async () => {
      writeFileSync(reportPath(input), report(true));
      return { ...ok, code: 1, stdout: report() };
    });
    expect(await executeCheck(input)).toMatchObject({ status: expectation === "red" ? "expected-red" : "failed", total: 1, failed: 1 });
  });

  it("rejects an exit-code parser paired with a report artifact", () => {
    const input = fixture();
    writeFileSync(path.join(input.root, "kitchen.config.json"), JSON.stringify({
      profiles: { report: { ...input.profile, kind: "command", parser: "exit-code" } },
    }));
    expect(() => loadConfig(input.root)).toThrow("reportFile requires a counted test parser");
  });
});
