import { describe, expect, it } from "vitest";
import { classifyTestOutput, validateCheckPlan, localUrl } from "../src/checks.ts";

function results(status: "passed" | "failed", message = "AssertionError: expected 0 to be 1") {
  return JSON.stringify({ numTotalTests: 1, numPassedTests: status === "passed" ? 1 : 0, numFailedTests: status === "failed" ? 1 : 0, testResults: [{ assertionResults: [{ fullName: "AC-1 sends one invitation", status, failureMessages: status === "failed" ? [message] : [] }] }] });
}

describe("RED and GREEN evidence", () => {
  it("recognizes a behavioral assertion failure as expected RED", () => {
    expect(classifyTestOutput(results("failed"), 1, "red", ["AC-1"])).toMatchObject({ status: "expected-red", total: 1, failed: 1 });
  });
  it("requires GREEN after implementation", () => {
    expect(classifyTestOutput(results("failed"), 1, "green", ["AC-1"]).status).toBe("failed");
    expect(classifyTestOutput(results("passed"), 0, "green", ["AC-1"]).status).toBe("passed");
  });
  it("rejects unexpectedly green new-behavior tests at the RED station", () => {
    expect(classifyTestOutput(results("passed"), 0, "red", ["AC-1"]).status).toBe("failed");
  });
  it("allows preservation tests to pass before implementation", () => {
    expect(classifyTestOutput(results("passed"), 0, "green", ["AC-1"]).status).toBe("passed");
  });
  it.each(["Cannot find module 'unrelated'", "SyntaxError: Unexpected token", "ECONNREFUSED", "TypeError: cannot read properties"])("does not count %s as behavioral RED", (message) => {
    expect(classifyTestOutput(results("failed", message), 1, "red", ["AC-1"]).status).toBe("failed");
  });
  it("does not trust exit zero when tests are absent", () => {
    expect(classifyTestOutput(JSON.stringify({ numTotalTests: 0, testResults: [] }), 0, "green", []).status).toBe("unverified");
  });
  it("rejects missing reports, skipped criteria, and unrelated failures", () => {
    expect(classifyTestOutput("not json", 1, "red", ["AC-1"]).status).toBe("unverified");
    expect(classifyTestOutput(results("passed"), 0, "green", ["AC-2"]).status).toBe("unverified");
    expect(classifyTestOutput(results("failed"), 1, "red", ["AC-2"]).status).not.toBe("expected-red");
  });
  it("rejects an exit error even with a passing report", () => {
    expect(classifyTestOutput(results("passed"), 1, "green", ["AC-1"]).status).toBe("failed");
  });
});

describe("local, explicit test plans", () => {
  it.each(["http://localhost:9000", "http://127.0.0.1:9000", "http://[::1]:9000"])("allows %s", (url) => {
    expect(localUrl(url)).toBe(true);
  });
  it.each(["https://app.hirebus.com", "http://localhost.evil.test", "file:///tmp/a", "http://user:pass@localhost"])("rejects %s", (url) => {
    expect(localUrl(url)).toBe(false);
  });
  it("rejects unsupported profiles and uncovered criteria", () => {
    const findings = validateCheckPlan(["AC-1", "AC-2"], [{ id: "unit", profile: "unknown", files: ["src/a.test.ts"], acIds: ["AC-1"], required: true, expectation: "red" }], {});
    expect(findings.some((item) => item.rule === "unknown-profile")).toBe(true);
    expect(findings.some((item) => item.rule === "uncovered-criterion")).toBe(true);
  });
  it("requires a unit test profile for tests-first implementation", () => {
    expect(validateCheckPlan(["AC-1"], [{ id: "manual", profile: "manual", files: [], acIds: ["AC-1"], required: true, expectation: "green" }], { manual: { kind: "manual" } }).some((item) => item.rule === "unit-tests-required")).toBe(true);
  });
});
