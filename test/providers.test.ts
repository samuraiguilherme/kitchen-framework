import { describe, expect, it } from "vitest";
import {
  parseProviderOutput,
  providerInvocation,
  validateAuthorOutput,
  validateReviewOutput,
} from "../src/providers.ts";
import { runProcess } from "../src/process.ts";
import { readFileSync } from "node:fs";

const author = {
  summary: "Invitations",
  questions: [],
  document: "# Intent",
  files: [],
  allowedPaths: [],
  unitTestFiles: [],
  scaffoldFiles: [],
  checks: [],
};
const review = { summary: "Review", findings: [] };

describe("provider contracts", () => {
  it("accepts questions or a nonempty intent document and rejects implementation metadata", () => {
    expect(validateAuthorOutput(author, "intent")).toEqual(author);
    const questions = { ...author, document: null, questions: [{ id: "audience", text: "Who is affected?" }] };
    expect(validateAuthorOutput(questions, "intent")).toEqual(questions);
    const invalid = [
      { ...author, document: null }, { ...author, document: "" }, { ...author, document: " \n\t" },
      { ...questions, document: "Unresolved draft" },
    ];
    for (const output of invalid)
      expect(() => validateAuthorOutput(output, "intent")).toThrow(/Invalid intent author output/);
    const forbidden = {
      files: [{ path: "src/answer.ts", action: "write", content: "export const answer = 42;", kind: "implementation" }],
      allowedPaths: ["src/answer.ts"], unitTestFiles: ["src/answer.test.ts"], scaffoldFiles: ["src/answer.ts"],
      checks: [{ id: "answer", profile: "unit", files: ["src/answer.test.ts"], acIds: ["AC-1"], required: true, expectation: "red" }],
    };
    for (const [key, value] of Object.entries(forbidden)) {
      const output = { ...author, [key]: value };
      expect(validateAuthorOutput(output)).toEqual(output);
      expect(() => validateAuthorOutput(output, "intent")).toThrow(/Invalid intent author output/);
    }
  });

  it("rejects the saved notice-banner proposal even after removing its prose and fences", () => {
    const event = JSON.parse(readFileSync(new URL("./fixtures/dsh-intent-invalid-final.json", import.meta.url), "utf8"));
    const embedded = JSON.parse(event.text.match(/```json\n([^]*?)\n```/)[1]);
    expect(validateAuthorOutput(embedded)).toEqual(embedded);
    expect(() => validateAuthorOutput(embedded, "intent")).toThrow(/Invalid intent author output/);
  });
  it.each(["unelevated", "elevated"] as const)(
    "selects the %s Windows implementation while retaining read-only policy",
    (mode) => {
      const invocation = providerInvocation(
        "codex",
        "schema",
        "answer",
        "author",
        undefined,
        undefined,
        mode,
      );
      expect(invocation.args).toContain(`windows.sandbox="${mode}"`);
      expect(invocation.args[invocation.args.indexOf("--sandbox") + 1]).toBe(
        "read-only",
      );
      expect(invocation.args).not.toContain(
        "--dangerously-bypass-approvals-and-sandbox",
      );
    },
  );
  it("parses Codex final output and Claude's structured envelope", () => {
    expect(parseProviderOutput("codex", JSON.stringify(author))).toEqual(
      author,
    );
    expect(
      parseProviderOutput(
        "claude",
        JSON.stringify({ structured_output: author, is_error: false }),
      ),
    ).toEqual(author);
  });
  it("rejects malformed JSON and Claude error/permission results", () => {
    expect(() => parseProviderOutput("codex", "```json\n{}\n```")).toThrow();
    expect(() =>
      parseProviderOutput(
        "claude",
        JSON.stringify({ is_error: true, result: "denied" }),
      ),
    ).toThrow();
    expect(() =>
      parseProviderOutput(
        "claude",
        JSON.stringify({
          structured_output: author,
          permission_denials: [{ tool_name: "Read" }],
        }),
      ),
    ).toThrow();
  });
  it("validates author and reviewer outputs at the boundary", () => {
    expect(validateAuthorOutput(author)).toEqual(author);
    expect(validateReviewOutput(review)).toEqual(review);
    expect(() =>
      validateAuthorOutput({ ...author, files: [{ path: "x" }] }),
    ).toThrow();
    expect(() =>
      validateReviewOutput({ findings: [{ blocking: true }] }),
    ).toThrow();
  });
  it("Codex reviewers have explicit read-only access and fresh sessions", () => {
    const invocation = providerInvocation(
      "codex",
      "schema.json",
      "answer.json",
      "review",
      undefined,
    );
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).not.toContain("resume");
    expect(invocation.args).toContain("--output-schema");
    expect(invocation.args).not.toContain("--model");
  });
  it("Claude reviewers expose reading tools and no shell or write tool", () => {
    const invocation = providerInvocation(
      "claude",
      "{}",
      "answer.json",
      "review",
      "configured-model",
    );
    const tools = invocation.args[invocation.args.indexOf("--tools") + 1];
    expect(tools).toBe("Read,Glob,Grep");
    expect(invocation.args).toContain("dontAsk");
    expect(invocation.args).toContain("configured-model");
    expect(
      JSON.parse(invocation.args[invocation.args.indexOf("--mcp-config") + 1]!),
    ).toEqual({ mcpServers: {} });
    expect(invocation.args).not.toContain("--dangerously-skip-permissions");
  });
});

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
