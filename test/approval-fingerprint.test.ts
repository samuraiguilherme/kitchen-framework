import { describe, expect, it } from "vitest";
import { approvalFingerprint } from "../src/approval-fingerprint.ts";
import { hash } from "../src/domain.ts";

const inputs = () => ({
  station: "implementation",
  upstream: [{ station: "unit-tests", fingerprint: "accepted-tests", status: "approved" }],
  artifact: "accepted-artifact",
  source: "checked-source",
  policy: {
    base: "origin/main",
    provider: { author: { provider: "deepseek", model: "local" }, reviewEnabled: false },
    profiles: { unit: { version: "1", command: "pnpm" } },
  },
  instructions: "Project conventions",
  evidence: [["report.json", "report-hash"]],
});

describe("approval fingerprint compatibility", () => {
  it("does not bind human approval to execution algorithm versions", () => {
    const before = inputs();
    const after = inputs();
    Object.assign(before.policy, { contextPolicyVersion: 4, sessionPolicyVersion: 1, tokenPromptVersion: 2 });
    Object.assign(after.policy, { contextPolicyVersion: 99, sessionPolicyVersion: 99, tokenPromptVersion: 99 });
    expect(approvalFingerprint(after)).toBe(approvalFingerprint(before));
  });

  it.each([
    { contextPolicyVersion: 1 },
    { contextPolicyVersion: 3, tokenPromptVersion: 1 },
    { contextPolicyVersion: 4, sessionPolicyVersion: 1, tokenPromptVersion: 2 },
  ])("preserves an existing approval and its upstream identity for %j", versions => {
    const current = inputs();
    const legacy = hash(JSON.stringify({ ...current, policy: { ...versions, ...current.policy } }));
    expect(approvalFingerprint(current, legacy)).toBe(legacy);
    expect(approvalFingerprint(current)).not.toBe(legacy);
  });

  it.each(["artifact", "source", "upstream", "instructions", "evidence", "profiles", "reviewEnabled"])(
    "still invalidates legacy approvals when %s changes", change => {
      const current = inputs();
      const legacy = hash(JSON.stringify({ ...current, policy: {
        contextPolicyVersion: 3, sessionPolicyVersion: 1, tokenPromptVersion: 2, ...current.policy,
      } }));
      if (change === "profiles") current.policy.profiles.unit.command = "different-command";
      else if (change === "reviewEnabled") current.policy.provider.reviewEnabled = true;
      else Object.assign(current, { [change]: "changed" });
      expect(approvalFingerprint(current, legacy)).not.toBe(legacy);
    },
  );

  it("does not grandfather an unrecognized approval hash", () => {
    expect(approvalFingerprint(inputs(), "unrecognized")).toBe(approvalFingerprint(inputs()));
  });
});
