import { lstatSync } from "node:fs";
import path from "node:path";
import { safePath } from "./domain.ts";
import type { ManualObservation } from "./types.ts";

export async function collectManualObservation(input: {
  id: string;
  acIds: string[];
  root: string;
  ask: (question: string) => Promise<string>;
  signal?: AbortSignal;
}): Promise<ManualObservation | undefined> {
  const ask = async (question: string) => {
    input.signal?.throwIfAborted();
    const answer = await input.ask(question);
    input.signal?.throwIfAborted();
    return answer.trim();
  };
  const label = `Manual check ${input.id}${input.acIds.length ? ` (${input.acIds.join(", ")})` : ""}`;
  let result: RegExpExecArray | null;
  let correction = "";
  for (;;) {
    const answer = await ask(
      `${correction}${label}\nWhat did you observe? Start with passed:, failed:, or not-applicable: followed by your observation (include a reason for N/A). Leave blank to keep this check unverified.`,
    );
    if (!answer) return undefined;
    result = /^(passed|failed|not-applicable)\s*:\s*(\S[^]*)$/i.exec(answer);
    if (result) break;
    correction = "Enter an explicit result and a nonempty observation, for example passed: The subtitle displays correctly.\n";
  }
  const status = result[1]!.toLowerCase() as ManualObservation["status"];
  const observation = result[2]!.trim();
  correction = "";
  for (;;) {
    const answer = await ask(
      `${correction}${label}\nEvidence file path(s) in this worktree: ${input.root}\nUse worktree-relative paths or absolute paths inside it; separate multiple files with semicolons. Save new screenshots in an ignored directory such as .local/evidence/. Leave blank to keep this check unverified.`,
    );
    if (!answer) return undefined;
    try {
      const evidence = [...new Set(answer.split(";").map((entry) => {
        const file = entry.trim().replace(/^(?:"([^]*)"|'([^]*)')$/, "$1$2");
        const relative = path.isAbsolute(file) ? path.relative(input.root, file) : file;
        const absolute = safePath(input.root, relative);
        if (!lstatSync(absolute).isFile())
          throw new Error(`Evidence must be an existing file: ${file}`);
        return path.relative(input.root, absolute).replaceAll("\\", "/");
      }))];
      return {
        id: input.id,
        status,
        observation,
        evidence,
        ...(status === "not-applicable" ? { reason: observation } : {}),
      };
    } catch (error) {
      correction = `Invalid evidence: ${error instanceof Error ? error.message : String(error)}\n`;
    }
  }
}
