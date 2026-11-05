import { describe, expect, it, vi } from "vitest";
import * as fingerprints from "../src/approval-fingerprint.ts";
import { hash } from "../src/domain.ts";
import { Kitchen } from "../src/kitchen.ts";
import { fixture, acceptDocs } from "./workflow-fixture.ts";

describe("completed approvals across execution upgrades", () => {
  it("preserves a legacy approval chain and resumes at failed verification", async () => {
    const setup = fixture();
    // Simulate approvals recorded before context/session/prompt optimizations.
    const legacy = vi.spyOn(fingerprints, "approvalFingerprint").mockImplementation(inputs =>
      hash(JSON.stringify({ ...inputs, policy: {
        contextPolicyVersion: 3, sessionPolicyVersion: 1, tokenPromptVersion: 1, ...inputs.policy,
      } })),
    );
    const completed = ["intent", "spec", "plan", "test-plan", "unit-tests", "implementation"] as const;
    try {
      await acceptDocs(setup.kitchen);
      for (const station of ["unit-tests", "implementation"] as const) {
        await setup.kitchen.run("answer", station);
        await setup.kitchen.approve("answer", station, { actor: "chef" });
      }
    } finally {
      legacy.mockRestore();
    }

    const accepted = await setup.kitchen.status("answer");
    for (const station of completed) expect(accepted.stations[station]?.status).toBe("approved");
    let verifyCalls = 0;
    const kitchen = new Kitchen({
      root: setup.root,
      github: setup.gateway,
      provider: async request => {
        if (request.station === "verify") {
          verifyCalls++;
          throw new Error("model-step limit 8 exceeded");
        }
        return setup.provider(request);
      },
    });
    await expect(kitchen.run("answer", "verify")).rejects.toThrow(/model-step limit/);
    const after = await kitchen.status("answer");
    expect(verifyCalls).toBe(1);
    expect(after.stations.verify?.status).toBe("failed");
    for (const station of completed) {
      expect(after.stations[station]?.status).toBe("approved");
      expect(after.stations[station]?.approval).toEqual(accepted.stations[station]?.approval);
    }
  });
});
