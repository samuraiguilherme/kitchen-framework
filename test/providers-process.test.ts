import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process.ts";

describe("subprocess execution", () => {
  it("stops the child when evidence capture fails, without reporting a timeout or cancellation", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "console.log('event'); setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      timeoutMs: 4000,
      onOutput() {
        throw new Error("disk unavailable");
      },
    });
    expect(result.failureReason).toBe(
      "Output capture failed: disk unavailable",
    );
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.stdout).toContain("event");
    expect(result.code).not.toBe(0);
  });
  it("passes spaces and shell metacharacters literally", async () => {
    const argument = "a space & $(no-command) `literal`";
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", argument],
      cwd: process.cwd(),
      timeoutMs: 10000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(argument);
  });
  it("passes prompts through stdin", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      cwd: process.cwd(),
      input: "multi\nline",
      timeoutMs: 10000,
    });
    expect(result.stdout).toBe("multi\nline");
  });
  it("terminates a timed-out command", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });
  it("supports cancellation without reporting success", async () => {
    const controller = new AbortController();
    const promise = runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      timeoutMs: 10000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(result.code).not.toBe(0);
  });
  it("reports missing executables as execution errors", async () => {
    const result = await runProcess({
      command: "kitchen-does-not-exist-12345",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 1000,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
