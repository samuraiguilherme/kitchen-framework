import { hash } from "./domain.ts";

interface ApprovalInputs extends Record<string, unknown> {
  policy: Record<string, unknown>;
}

const executionVersions = new Set([
  "contextPolicyVersion", "sessionPolicyVersion", "tokenPromptVersion",
]);

export function approvalFingerprint(inputs: ApprovalInputs, previous?: string): string {
  // Context construction, session reuse and prompt optimizations affect future
  // execution, not the artifacts and evidence a human already accepted.
  const policy = Object.fromEntries(Object.entries(inputs.policy)
    .filter(([key]) => !executionVersions.has(key)));
  const stable = { ...inputs, policy };
  const fingerprint = hash(JSON.stringify(stable));
  if (!previous || previous === fingerprint) return fingerprint;

  // Keep existing approval identities (including downstream references) when
  // only these historical execution-version fields differ. Every material
  // input still has to reproduce the exact saved hash. Do not rebaseline an
  // unknown legacy fingerprint against today's candidate.
  for (const contextPolicyVersion of [undefined, 1, 2, 3, 4])
    for (const sessionPolicyVersion of [undefined, 1])
      for (const tokenPromptVersion of [undefined, 1, 2]) {
        const legacy = { ...stable, policy: {
          contextPolicyVersion, sessionPolicyVersion, tokenPromptVersion, ...policy,
        } };
        if (hash(JSON.stringify(legacy)) === previous) return previous;
      }
  return fingerprint;
}
