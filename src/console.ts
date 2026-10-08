import path from "node:path";
import { gateReady, stationOrder } from "./domain.ts";
import type { FeatureState, Station } from "./types.ts";

export function featureSummary(
  state: FeatureState,
  selected?: Station,
): string {
  const lines = [
    `Feature: ${state.feature}`,
    `Branch: ${state.branch}`,
    `Worktree: ${state.worktree}`,
  ];
  for (const station of selected ? [selected] : stationOrder) {
    const record = state.stations[station];
    if (!record) continue;
    lines.push("", `${station}: ${record.status}`);
    const summary = record.summary || record.output?.summary;
    if (summary) lines.push(summary);
    for (const file of record.artifactFiles)
      lines.push(`File: ${path.resolve(state.worktree, file)}`);
    if (record.commit) lines.push(`Commit: ${record.commit}`);
    else if (
      ["intent", "spec", "plan", "test-plan"].includes(station) &&
      record.status === "awaiting-approval"
    )
      lines.push("Commit: pending station approval");
    for (const finding of record.findings)
      lines.push(
        `[${finding.blocking ? "blocking" : "advisory"}] ${finding.id}: ${finding.evidence}`,
        `Resolution: ${finding.resolution}`,
      );
    for (const check of record.checks)
      lines.push(
        `Check ${check.id}: ${check.status}${check.reason ? ` — ${check.reason}` : ""}`,
      );
    if (record.status === "awaiting-input") {
      lines.push("Human answers are required before this station can finish.");
      for (const question of record.output?.questions ?? [])
        lines.push(`- ${question.id}: ${question.text}`);
    }
    if (record.error) lines.push(`Error: ${record.error}`);
  }
  if (state.pr) {
    lines.push("", `Draft PR: ${state.pr}`);
    return lines.join("\n");
  }
  const next = stationOrder.find(
    (station) => state.stations[station]?.status !== "approved",
  );
  if (next) {
    const record = state.stations[next];
    const run =
      next === "publish"
        ? `pnpm kitchen publish ${state.feature} --preview`
        : `pnpm kitchen run ${state.feature} ${next}`;
    let command = run;
    if (record?.status === "awaiting-approval") {
      if (gateReady(record.findings, record.checks, {}))
        command = `pnpm kitchen approve ${state.feature} ${next} --actor <your-name>`;
      else
        lines.push(
          "",
          "Resolve blocking findings or check failures before approval.",
        );
    } else if (record?.status === "awaiting-input")
      lines.push(
        "",
        "Answer the saved questions interactively, or supply --feedback-file <answers.txt>.",
      );
    lines.push("", `Next: ${command}`);
  } else if (state.stations.publish?.status === "approved")
    lines.push("", `Next: pnpm kitchen publish ${state.feature}`);
  return lines.join("\n");
}
