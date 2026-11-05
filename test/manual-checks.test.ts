import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCheck } from "../src/checks.ts";
import { gateReady, hash } from "../src/domain.ts";
import type { ExecuteCheckInput } from "../src/checks.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): ExecuteCheckInput {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-manual-"));
  roots.push(root);
  mkdirSync(path.join(root, ".local/evidence"), { recursive: true });
  return {
    definition: { id: "manual-visual", profile: "manual", acIds: ["AC-1"], files: [], required: true, expectation: "green" },
    profile: { kind: "manual" },
    root,
    runDir: path.join(root, "runs"),
    fingerprint: "candidate-source",
    green: true,
  };
}

describe("interactive manual checks", () => {
  it("collects two answers, snapshots evidence and binds the result to the checked candidate", async () => {
    const input = fixture();
    const questions: string[] = [];
    const result = await executeCheck({
      ...input,
      ask: async (question) => {
        questions.push(question);
        if (questions.length === 1) return "passed: The sidebar subtitle displays the required suffix.";
        // Evidence may be captured while the runner waits for the second answer.
        writeFileSync(path.join(input.root, ".local/evidence/brand.png"), "screenshot bytes");
        return ".local/evidence/brand.png";
      },
    });
    expect(questions).toHaveLength(2);
    expect(questions[0]).toContain("manual-visual (AC-1)");
    expect(questions[1]).toContain(input.root);
    expect(result).toMatchObject({ status: "passed", sourceFingerprint: input.fingerprint, observation: "The sidebar subtitle displays the required suffix." });
    expect(gateReady([], [result], {})).toBe(true);
    const evidence = path.join(input.runDir, "manual-manual-visual.json");
    const raw = readFileSync(evidence, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      id: "manual-visual", status: "passed", evidence: [".local/evidence/brand.png"],
      files: [{ file: ".local/evidence/brand.png", content: Buffer.from("screenshot bytes").toString("base64") }],
    });
    expect(result.evidenceHashes?.[evidence]).toBe(hash(raw));
    writeFileSync(path.join(input.root, ".local/evidence/brand.png"), "later edit");
    expect(readFileSync(evidence, "utf8")).toBe(raw);
  });

  it.each(["failed", "not-applicable"] as const)("preserves the human's %s result", async (status) => {
    const input = fixture();
    writeFileSync(path.join(input.root, ".local/evidence/notes.txt"), "Actual observation");
    const answers = [`${status}: The native view could not be opened on this platform.`, ".local/evidence/notes.txt"];
    const result = await executeCheck({ ...input, ask: async () => answers.shift()! });
    expect(result.status).toBe(status);
    expect(result.reason).toBe(status === "not-applicable" ? "The native view could not be opened on this platform." : undefined);
    expect(gateReady([], [result], {})).toBe(status === "not-applicable");
  });

  it("requires an explicit result and observation rather than treating arbitrary text as a pass", async () => {
    const input = fixture();
    writeFileSync(path.join(input.root, ".local/evidence/notes.txt"), "Observed failure");
    const answers = ["The view looks different", "passed:   ", "FAILED: The subtitle is clipped.", ".local/evidence/notes.txt"];
    const questions: string[] = [];
    const result = await executeCheck({ ...input, ask: async (question) => { questions.push(question); return answers.shift()!; } });
    expect(questions).toHaveLength(4);
    expect(questions[1]).toContain("Enter an explicit result and a nonempty observation");
    expect(questions[2]).toContain("Enter an explicit result and a nonempty observation");
    expect(result.status).toBe("failed");
    expect(result.observation).toBe("The subtitle is clipped.");
  });

  it("reasks for missing, escaping and directory paths and accepts quoted paths containing spaces", async () => {
    const input = fixture();
    const first = path.join(input.root, ".local/evidence/brand screenshot.png");
    writeFileSync(first, "image");
    writeFileSync(path.join(input.root, ".local/evidence/notes.txt"), "notes");
    const answers = [
      "passed: The required subtitle is visible.",
      ".local/evidence/missing.png",
      path.join(input.root, "..", "outside.png"),
      ".local/evidence",
      `"${first}"; '.local/evidence/notes.txt'`,
    ];
    const questions: string[] = [];
    const result = await executeCheck({ ...input, ask: async (question) => { questions.push(question); return answers.shift()!; } });
    expect(questions).toHaveLength(5);
    expect(questions.slice(2).every(question => question.startsWith("Invalid evidence:"))).toBe(true);
    expect(result.status).toBe("passed");
    expect(JSON.parse(readFileSync(path.join(input.runDir, "manual-manual-visual.json"), "utf8")).evidence)
      .toEqual([".local/evidence/brand screenshot.png", ".local/evidence/notes.txt"]);
  });

  it.each([1, 2])("leaves the check unverified when answer %s is blank", async (blank) => {
    const input = fixture();
    const ask = vi.fn(async () => blank === 1 || ask.mock.calls.length === 2 ? " " : "passed: Looks correct.");
    const result = await executeCheck({ ...input, ask });
    expect(ask).toHaveBeenCalledTimes(blank);
    expect(result.status).toBe("unverified");
    expect(gateReady([], [result], {})).toBe(false);
    expect(existsSync(path.join(input.runDir, "manual-manual-visual.json"))).toBe(false);
  });

  it("keeps non-interactive checks unverified without supplied observations", async () => {
    const result = await executeCheck(fixture());
    expect(result.status).toBe("unverified");
    expect(gateReady([], [result], {})).toBe(false);
  });

  it("uses observations supplied in advance without prompting", async () => {
    const input = fixture();
    writeFileSync(path.join(input.root, ".local/evidence/notes.txt"), "Observed");
    const ask = vi.fn(async () => { throw new Error("Unexpected question"); });
    const result = await executeCheck({ ...input, ask, observations: [{
      id: "manual-visual", status: "passed", observation: "Verified in the built app.", evidence: [".local/evidence/notes.txt"],
    }] });
    expect(ask).not.toHaveBeenCalled();
    expect(result.status).toBe("passed");
  });

  it("does not save a passing observation when input is cancelled", async () => {
    const input = fixture();
    const controller = new AbortController();
    const ask = vi.fn(async () => { controller.abort(new Error("Input cancelled")); return "passed: Looks correct."; });
    await expect(executeCheck({ ...input, signal: controller.signal, ask })).rejects.toThrow("Input cancelled");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(input.runDir, "manual-manual-visual.json"))).toBe(false);
  });
});
