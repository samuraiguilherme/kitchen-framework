import { describe, expect, it } from "vitest";
import { parseProviderOutput, providerInvocation, validateAuthorOutput, validateReviewOutput } from "../src/providers.ts";
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
  it.each(["spec", "plan", "test-plan"] as const)(
    "requires a nonempty document and no source proposals at %s",
    (station) => {
      const document = { ...author, document: `# ${station}\nComplete document.` };
      const questions = {
        ...author,
        document: null,
        questions: [{ id: "audience", text: "Who is affected?" }],
      };
      expect(validateAuthorOutput(document, station)).toEqual(document);
      expect(validateAuthorOutput(questions, station)).toEqual(questions);
      const files = [{
        path: "src/answer.ts", action: "write", content: "export const answer = 42;", kind: "implementation",
      }];
      for (const output of [
        { ...document, document: null },
        { ...document, document: "" },
        { ...document, document: " \n\t" },
        { ...document, files },
        { ...document, document: null, files },
        { ...questions, document: "Unresolved draft" },
        { ...questions, files },
        { ...questions, allowedPaths: ["src/answer.ts"] },
      ]) {
        expect(validateAuthorOutput(output)).toEqual(output);
        expect(() => validateAuthorOutput(output, station)).toThrow(`Invalid ${station} author output`);
      }
    },
  );

  it("preserves plan and test-plan manifests in document candidates", () => {
    const plan = { ...author, allowedPaths: ["src/answer.ts", "src/answer.test.ts"] };
    const testPlan = {
      ...author, unitTestFiles: ["src/answer.test.ts"], scaffoldFiles: ["src/answer.ts"],
      checks: [{ id: "answer", profile: "unit", files: ["src/answer.test.ts"], acIds: ["AC-1"], required: true, expectation: "red" }],
    };
    expect(validateAuthorOutput(plan, "plan")).toEqual(plan);
    expect(validateAuthorOutput(testPlan, "test-plan")).toEqual(testPlan);
  });

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
