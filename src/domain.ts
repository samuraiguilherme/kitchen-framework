import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { FeatureState, Finding, Station, StationRecord } from "./types.ts";

export const stationOrder = [
  "intent",
  "spec",
  "plan",
  "test-plan",
  "unit-tests",
  "implementation",
  "verify",
  "publish",
] as const;
export const rubricVersion = "1.0.0";
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function validateFeature(feature: string): string {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature) ||
    feature.length > 64 ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(feature)
  )
    throw new Error(
      "Feature must be a non-reserved kebab-case name, at most 64 characters.",
    );
  return feature;
}
function absolutePath(root: string, file: string): string {
  const segments = file.replaceAll("\\", "/").split("/");
  if (
    !file ||
    path.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    segments.some(
      (s) =>
        s === ".." ||
        s.includes(":") ||
        /[. ]$/.test(s) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s),
    ) ||
    segments.some((s) =>
      /^(\.git|\.kitchen|\.codex|\.claude|\.agents|node_modules|\.env(?:\..*)?)$/i.test(
        s,
      ),
    )
  )
    throw new Error(`Unsafe path: ${file}`);
  return path.resolve(root, file);
}
function requireContained(anchor: string, resolved: string, file: string): void {
  const relative = path.relative(anchor, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Path escapes worktree: ${file}`);
}
export function safePath(root: string, file: string): string {
  const absolute = absolutePath(root, file);
  const anchor = realpathSync(root);
  let parent = absolute;
  while (!existsSync(parent)) parent = path.dirname(parent);
  requireContained(anchor, realpathSync(parent), file);
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink())
    throw new Error(`Output cannot be a symlink: ${file}`);
  return absolute;
}
export function fileDigests(
  root: string,
  files: string[],
): { entries: Array<[string, string | null]>; byteCount: number } {
  const names = [...new Set(files)].sort();
  if (!names.length) return { entries: [], byteCount: 0 };
  // One scan owns its path cache. Later scans must resolve the directories again
  // so source edits and retargeted directory symlinks cannot reuse old validation.
  const absoluteRoot = path.resolve(root);
  const anchor = realpathSync(root);
  const parents = new Map([[absoluteRoot, anchor]]);
  let byteCount = 0;
  const entries = names.map((file): [string, string | null] => {
    const absolute = absolutePath(root, file);
    const exists = existsSync(absolute);
    let parent = exists ? path.dirname(absolute) : absolute;
    if (absolute === absoluteRoot) parent = absoluteRoot;
    while (!parents.has(parent) && !existsSync(parent))
      parent = path.dirname(parent);
    let resolved = parents.get(parent);
    if (resolved === undefined) {
      resolved = realpathSync(parent);
      parents.set(parent, resolved);
    }
    const canonical = exists
      ? absolute === absoluteRoot
        ? anchor
        : path.join(resolved, path.basename(absolute))
      : resolved;
    requireContained(anchor, canonical, file);
    if (exists && lstatSync(absolute).isSymbolicLink())
      throw new Error(`Output cannot be a symlink: ${file}`);
    // Read the canonical parent path we validated, rather than following a
    // directory link again after resolving it (or its cached parent).
    if (!exists) return [file, null];
    const contents = readFileSync(canonical);
    byteCount += contents.length;
    return [file, hash(contents)];
  });
  return { entries, byteCount };
}
export function digest(root: string, files: string[]): string {
  return hash(JSON.stringify(fileDigests(root, files).entries));
}
export function acceptanceIds(document: string): string[] {
  const ids = [...document.matchAll(/^\|\s*(AC-[0-9]+)\s*\|/gm)].map(
    (match) => match[1]!,
  );
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate acceptance criterion ID");
  return ids;
}
export function finding(
  rule: string,
  evidence: string,
  resolution: string,
  consequence = "The station cannot establish its contract.",
): Finding {
  return {
    id: `${rule}-${hash(evidence).slice(0, 10)}`,
    rule,
    blocking: true,
    evidence,
    consequence,
    resolution,
  };
}
export function lintDocument(station: string, document: string): Finding[] {
  const headings: Record<string, string[]> = {
    intent: [
      "What the product can't do today",
      "Who is affected",
      "What better looks like",
      "Out of scope",
      "Constraints",
    ],
    spec: [
      "Summary",
      "Requirements and acceptance criteria",
      "Roles and permissions",
      "Business rules and edge cases",
      "Non-goals",
    ],
    plan: [
      "Description",
      "Files to change",
      "Steps to implement",
      "Test plan",
      "Risks",
    ],
    "test-plan": [
      "Acceptance coverage",
      "Unit tests",
      "Regression",
      "Required evidence",
    ],
  };
  const findings: Finding[] = [];
  for (const heading of headings[station] ?? []) {
    const sections = document.split(/^## /m).slice(1);
    if (
      !sections.some(
        (s) => s.startsWith(`${heading}\n`) || s.startsWith(`${heading}\r\n`),
      )
    )
      findings.push(finding("missing-section", heading, "Fill this section."));
    else if (
      sections.some(
        (s) =>
          s.split(/\r?\n/)[0] === heading &&
          !s
            .slice(heading.length)
            .replace(/<!--[^]*?-->/g, "")
            .trim(),
      )
    )
      findings.push(
        finding(
          "empty-section",
          heading,
          "Provide concrete content or an explained N/A.",
        ),
      );
  }
  if (
    /<(?:Title|title|issue#|slug|name|role|step|capability|benefit|github issue url)[^>]*>|\b(?:TODO|TBD)\b|YYYY-MM-DD|`__`/.test(
      document,
    )
  )
    findings.push(
      finding(
        "placeholder",
        "Unresolved template placeholder",
        "Resolve the placeholder or record an explicit product question.",
      ),
    );
  if (station === "spec") {
    const ids = acceptanceIds(document);
    if (!ids.length || /^\|\s*AC-\d+\s*\|\s*\|/m.test(document))
      findings.push(
        finding(
          "acceptance-criteria",
          "Missing observable acceptance criteria",
          "Define stable AC-n table rows with concrete expected behavior.",
        ),
      );
  }
  if (station === "plan" && !document.includes("test-plan.md"))
    findings.push(
      finding(
        "separate-test-plan",
        "Plan lacks test-plan.md reference",
        "Link the separate test plan.",
      ),
    );
  return findings;
}
export function gateReady(
  findings: Finding[],
  checks: Array<{ id: string; required: boolean; status: string }>,
  resolutions: Record<string, string>,
): boolean {
  return (
    findings.every((f) => !f.blocking || Boolean(resolutions[f.id]?.trim())) &&
    checks.every(
      (c) =>
        !c.required ||
        ["passed", "expected-red", "not-applicable"].includes(c.status),
    )
  );
}
export function requireAwaitingApproval(
  state: FeatureState,
  station: Station,
): StationRecord {
  const record = state.stations[station];
  if (record?.status === "awaiting-input")
    throw new Error(
      `${station} is awaiting-input and needs human answers before approval.\nNext: pnpm kitchen run ${state.feature} ${station} --feedback-file <answers.txt>`,
    );
  if (!record || record.status !== "awaiting-approval") {
    const command =
      station === "publish"
        ? `pnpm kitchen publish ${state.feature} --preview`
        : `pnpm kitchen run ${state.feature} ${station}`;
    throw new Error(
      `${station} is not awaiting approval (status: ${record?.status ?? "not-started"}). Rerun and review it.\nNext: ${command}`,
    );
  }
  return record;
}
