import path from "node:path";
import type { CheckDefinition, Config } from "./types.ts";

// Check configuration facts before spending inference time. Coverage and RED/GREEN
// remain candidate/execution gates; readiness must never claim those passed.
export function profileReadiness(
  config: Pick<Config, "profiles">,
  checks: Pick<CheckDefinition, "profile">[] = [],
): string[] {
  const issues: string[] = [];
  if (!Object.values(config.profiles).some(profile => profile.kind === "unit"))
    issues.push("Configure at least one unit profile with a counted test parser before authoring the test plan.");
  const missing = [...new Set(checks.map(check => check.profile))]
    .filter(id => !Object.hasOwn(config.profiles, id)).sort();
  if (missing.length)
    issues.push(`Accepted documents reference unconfigured profiles: ${missing.join(", ")}. Configure these IDs or revise the accepted document through its station.`);
  return issues;
}

export function requireTestPlanReadiness(
  root: string,
  config: Pick<Config, "profiles">,
  checks: Pick<CheckDefinition, "profile">[],
): void {
  const issues = profileReadiness(config, checks);
  if (issues.length)
    throw new Error(`Test-plan readiness failed; no provider was called. Effective configuration root: ${path.resolve(root)}. ` +
      "Edit kitchen.config.json or kitchen.config.local.json at that root. " + issues.join(" "));
}
