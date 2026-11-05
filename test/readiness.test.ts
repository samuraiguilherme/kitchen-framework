import { describe, expect, it } from "vitest";
import { profileReadiness, requireTestPlanReadiness } from "../src/readiness.ts";
import type { Profile } from "../src/types.ts";

const unit: Profile = { kind: "unit", command: "node", args: ["unit.mjs"], parser: "vitest-json", timeoutMs: 1000 };

describe("test-plan readiness", () => {
  it("rejects RAD's empty profile map before another author attempt", () => {
    expect(() => requireTestPlanReadiness("rad", { profiles: {} }, [{ profile: "vitest" }]))
      .toThrow(/no provider was called.*Effective configuration root:.*Configure at least one unit.*vitest/);
  });
  it("requires a unit profile even when command or manual profiles exist", () => {
    expect(profileReadiness({ profiles: { manual: { kind: "manual" } } })).toHaveLength(1);
  });
  it("checks distinct accepted profile references, including inherited object names", () => {
    const config = { profiles: { unit } };
    expect(profileReadiness(config, [{ profile: "vitest" }, { profile: "vitest" }, { profile: "toString" }]))
      .toEqual([expect.stringContaining("toString, vitest")]);
    expect(profileReadiness(config, [{ profile: "unit" }])).toEqual([]);
  });
});
