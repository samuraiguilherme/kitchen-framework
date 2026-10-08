import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluate } from "../src/evaluate.ts";

describe("verifier calibration", () => {
  it("does not mistake proposed labels for human-labeled measurements", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-eval-"));
    expect(await evaluate(root, "intent")).toMatchObject({
      measured: false,
      labeled: 0,
    });
  });
  it("counts missed problems and unnecessary findings against supplied human labels", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-eval-"));
    const labels = path.join(root, "labels.json");
    writeFileSync(
      labels,
      JSON.stringify({
        "intent-acceptable": "acceptable",
        "intent-flawed": "flawed",
      }),
    );
    let calls = 0;
    const result = await evaluate(root, "intent", {
      live: true,
      labels,
      provider: async () => {
        calls++;
        return {
          summary: "Fixture judgment",
          findings:
            calls === 1
              ? [
                  {
                    id: "false-alarm",
                    rule: "fixture",
                    blocking: true,
                    evidence: "fixture evidence",
                    consequence: "fixture",
                    resolution: "fixture",
                  },
                ]
              : [],
        };
      },
    });
    expect(result).toMatchObject({
      measured: true,
      labeled: 2,
      missedProblems: 1,
      unnecessaryFindings: 1,
    });
  });
});
