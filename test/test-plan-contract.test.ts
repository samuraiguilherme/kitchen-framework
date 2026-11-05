import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateCheckPlan } from "../src/checks.ts";
import { Kitchen } from "../src/kitchen.ts";
import type { CheckDefinition, Config } from "../src/types.ts";
import { acceptDocs, checks, fixture } from "./workflow-fixture.ts";

const unitCheck: CheckDefinition = {
  id: "brand-subtitle", profile: "unit", files: ["tests/brand.test.ts"],
  acIds: ["AC-1"], required: true, expectation: "red",
};

describe("test-plan contract validation", () => {
  it("groups unknown profiles and retains every affected check in the diagnostic", () => {
    const definitions = [unitCheck, { ...unitCheck, id: "regression" }];
    const findings = validateCheckPlan(["AC-1"], definitions, {}, unitCheck.files);
    const unknown = findings.filter(({ rule }) => rule === "unknown-profile");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ evidence: "unit", blocking: true });
    expect(unknown[0]!.resolution).toContain("brand-subtitle, regression");
    expect(new Set(findings.map(({ id }) => id)).size).toBe(findings.length);
  });

  it("treats inherited object names as unknown profiles", () => {
    const findings = validateCheckPlan(["AC-1"], [
      { ...unitCheck, profile: "toString" },
    ], {}, unitCheck.files);
    expect(findings.map(({ rule }) => rule)).toEqual([
      "unknown-profile", "uncovered-criterion", "unit-tests-required",
    ]);
  });

  it.each(["src/brand.tsx", "tests/existing.test.ts"])(
    "rejects %s in a unit check before baseline execution", (file) => {
      const findings = validateCheckPlan(["AC-1"], [
        { ...unitCheck, files: [...unitCheck.files, file] },
      ], { unit: { kind: "unit" } }, unitCheck.files);
      expect(findings).toEqual([
        expect.objectContaining({ rule: "unit-scope", evidence: unitCheck.id }),
      ]);
    },
  );

  it("accepts a scoped RED unit check alongside unscoped GREEN regression/build commands", () => {
    const findings = validateCheckPlan(["AC-1"], [
      unitCheck,
      { id: "regression", profile: "regression", files: [], acIds: [], required: true, expectation: "green" },
      { id: "build", profile: "build", files: [], acIds: [], required: true, expectation: "green" },
      { id: "visual", profile: "manual", files: [], acIds: ["AC-1"], required: true, expectation: "green" },
    ], {
      unit: { kind: "unit" }, regression: { kind: "command" },
      build: { kind: "command" }, manual: { kind: "manual" },
    }, unitCheck.files);
    expect(findings).toEqual([]);
  });
});

describe("test-plan readiness and approval gates", () => {
  it("can repair profile names retained in unused upstream document output", async () => {
    const setup = fixture();
    const kitchen = new Kitchen({
      root: setup.root, github: setup.gateway,
      provider: async (request) => {
        const output = await setup.provider(request);
        if (request.station === "plan" && "checks" in output)
          output.checks = checks.map((check) => ({ ...check, profile: "retired-vitest" }));
        return output;
      },
    });
    await acceptDocs(kitchen);
    expect((await kitchen.status("answer")).stations["test-plan"]?.status).toBe("approved");
  });

  it.each([{}, { manual: { kind: "manual" } }] as Config["profiles"][])(
    "preserves the previous candidate without calling a provider when unit profiles are missing", async (profiles) => {
      const setup = fixture();
      await acceptDocs(setup.kitchen);
      const directory = path.join(setup.root, ".kitchen/features/answer");
      const stateFile = path.join(directory, "state.json");
      const before = readFileSync(stateFile, "utf8");
      const runs = readdirSync(path.join(directory, "runs"));
      const configFile = path.join(setup.root, "kitchen.config.json");
      const config = JSON.parse(readFileSync(configFile, "utf8"));
      config.profiles = profiles;
      writeFileSync(configFile, JSON.stringify(config));
      const callCount = setup.calls.length;

      await expect(setup.kitchen.run("answer", "test-plan", {
        feedback: "Retry the test plan",
      })).rejects.toThrow(/no provider was called.*Effective configuration root:/);
      expect(setup.calls).toHaveLength(callCount);
      expect(readFileSync(stateFile, "utf8")).toBe(before);
      expect(readdirSync(path.join(directory, "runs"))).toEqual(runs);
    },
  );

  it("blocks a production file in a generated unit check at test planning and approval", async () => {
    const setup = fixture();
    const kitchen = new Kitchen({
      root: setup.root, github: setup.gateway,
      provider: async (request) => {
        const output = await setup.provider(request);
        if (request.station === "test-plan" && "checks" in output)
          output.checks = checks.map((check) => ({
            ...check, files: [...check.files, "src/answer.ts"],
          }));
        return output;
      },
    });
    await kitchen.start("answer", { request: "Return 42." });
    for (const station of ["intent", "spec", "plan"] as const) {
      await kitchen.run("answer", station);
      await kitchen.approve("answer", station, { actor: "chef" });
    }
    const state = await kitchen.run("answer", "test-plan");
    const findings = state.stations["test-plan"]!.findings;
    expect(findings).toEqual([
      expect.objectContaining({ rule: "unit-scope", blocking: true }),
    ]);
    await expect(kitchen.approve("answer", "test-plan", {
      actor: "chef", resolutions: Object.fromEntries(findings.map(({ id }) => [id, "Waive scope"])),
    })).rejects.toThrow("Invalid executable test plan cannot be waived");
  });
});
