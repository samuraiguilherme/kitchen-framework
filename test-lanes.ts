// Unclassified/new files stay in integration, so the full gate cannot silently
// lose coverage. Keep OS/process/network tests out of the edit-time core lane.
export const coreTests = [
  "checks", "config", "deepseek-retry", "doctor", "domain", "evaluate",
  "manual-checks", "metrics", "provider-executable", "provider-progress", "providers",
  "rad-regressions", "readiness", "replay", "test-plan", "test-environment",
  "timings", "token-budget",
].map(name => `test/${name}.test.ts`);
