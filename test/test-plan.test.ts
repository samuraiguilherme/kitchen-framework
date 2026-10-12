import { describe, expect, it } from "vitest";
import { validateCheckPlan } from "../src/checks.ts";
import { normalizeTestPlan } from "../src/test-plan.ts";
import type { AuthorOutput } from "../src/types.ts";

function candidate(ids: string[], document = ""): AuthorOutput {
  return {
    summary: "Prepared",
    questions: [],
    document,
    files: [],
    allowedPaths: [],
    unitTestFiles: ["src/K_Runtime.test.ts"],
    scaffoldFiles: [],
    checks: ids.map((id) => ({
      id,
      profile: "unit",
      files: ["src/K_Runtime.test.ts"],
      acIds: ["AC-1"],
      required: true,
      expectation: "red",
    })),
  };
}

describe("generated test-plan IDs", () => {
  it("uses kebab-case without changing profiles, files, criteria or the raw proposal", () => {
    const raw = candidate([
      "K-runtime",
      "K-backend-rules-access-quotes",
      "AppController",
      " Manual__Browser-- ",
      "HTTPChecks",
    ]);
    const normalized = normalizeTestPlan(raw);
    expect(normalized.checks.map((check) => check.id)).toEqual([
      "k-runtime",
      "k-backend-rules-access-quotes",
      "app-controller",
      "manual-browser",
      "http-checks",
    ]);
    for (const [index, check] of normalized.checks.entries()) {
      expect({ ...check, id: raw.checks[index]!.id }).toEqual(
        raw.checks[index],
      );
    }
    expect(raw.checks[0]!.id).toBe("K-runtime");
    expect(normalized.unitTestFiles).toEqual(raw.unitTestFiles);
    expect(normalizeTestPlan(normalized)).toEqual(normalized);
  });

  it("updates complete references together while preserving paths and longer IDs", () => {
    const normalized = normalizeTestPlan(
      candidate(
        ["K-runtime", "K-runtime-extra", "K_Runtime", "K-ui+browser"],
        "| K-runtime | K-runtime-extra |\n### K_Runtime — Runtime\n" +
          "Use `K-runtime`, `K_Runtime`, and K-ui+browser.\n" +
          "Keep K-runtime-unrelated, src/K_Runtime.test.ts and K_Runtime.test.ts.\n",
      ),
    );
    expect(normalized.document).toBe(
      "| k-runtime | k-runtime-extra |\n### k-runtime — Runtime\n" +
        "Use `k-runtime`, `k-runtime`, and k-ui-browser.\n" +
        "Keep K-runtime-unrelated, src/K_Runtime.test.ts and K_Runtime.test.ts.\n",
    );
  });

  it("keeps normalization collisions and empty IDs blocked", () => {
    for (const ids of [
      ["K-runtime", "k-runtime"],
      ["", "!!!"],
    ]) {
      const normalized = normalizeTestPlan(candidate(ids));
      const findings = validateCheckPlan(["AC-1"], normalized.checks, {
        unit: { kind: "unit" },
      });
      expect(findings).toContainEqual(
        expect.objectContaining({ rule: "duplicate-check", blocking: true }),
      );
      if (ids.includes("")) {
        expect(findings).toContainEqual(
          expect.objectContaining({ rule: "invalid-check-id", blocking: true }),
        );
      }
    }
  });
});
