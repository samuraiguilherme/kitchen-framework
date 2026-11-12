import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runWorkerPair } from "./analysis.ts";
import { digest, safePath } from "./domain.ts";
import { sourceFingerprint } from "./git.ts";
import { promptSections, timed } from "./metrics.ts";
import { validateFileProposal } from "./providers.ts";
import type {
  AuthorOutput, FileChange, FileProposal, ProposalGroups, ProposalStation,
  Provider, ProviderRequest, RoleConfig, RunMetrics,
} from "./types.ts";

function fileLocation(root: string, file: string, owned = false): string {
  let existing = safePath(root, file);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const info = statSync(existing);
  if (missing.length ? !info.isDirectory() : !info.isFile())
    throw new Error(`Proposal path must address a regular file: ${file}`);
  const location = path.join(realpathSync(existing), ...missing);
  if (owned) {
    const expected = path.join(realpathSync(root), file);
    const samePath = process.platform === "win32"
      ? location.toLowerCase() === expected.toLowerCase()
      : location === expected;
    if (!samePath || (!missing.length && info.nlink > 1))
      throw new Error(`Proposal path must not alias another file: ${file}`);
  }
  // Reject case and Unicode aliases on every platform so the groups remain portable.
  return location.normalize("NFC").toLowerCase();
}

function validateOwnership(root: string, groups: ProposalGroups, eligible: readonly string[], protectedPaths: readonly string[]): string[] {
  const owned = groups.flat();
  const scope = new Set(eligible);
  if (groups.some(group => !group.length) || new Set(owned).size !== owned.length)
    throw new Error("Proposal groups must be nonempty and own disjoint files.");
  for (const file of owned) {
    if (file.includes("\\") || path.posix.normalize(file) !== file || file.endsWith("/"))
      throw new Error(`Proposal groups require exact repository-relative file paths: ${file}`);
    if (!scope.has(file)) throw new Error(`Proposal ownership is outside the station's approved file scope: ${file}`);
    scope.delete(file);
  }
  if (scope.size) throw new Error(`Proposal groups must assign every eligible file. Missing: ${[...scope].join(", ")}`);

  const locations = new Map(protectedPaths.map(file => [fileLocation(root, file), file]));
  for (const file of owned) {
    const location = fileLocation(root, file, true);
    for (const [other, otherFile] of locations)
      if (other === location || location.startsWith(other + path.sep) || other.startsWith(location + path.sep))
        throw new Error(`Conflicting proposal paths: ${file} and ${otherFile}`);
    locations.set(location, file);
  }
  return [...locations.keys()];
}

function orderProposal(value: unknown, files: readonly string[], id: string): FileProposal {
  const proposal = validateFileProposal(value);
  const owned = new Set(files);
  const changes = new Map<string, FileChange>();
  for (const change of proposal.files) {
    if (!owned.has(change.path)) throw new Error(`Proposal ${id} does not own ${change.path}`);
    if (changes.has(change.path)) throw new Error(`Duplicate file proposal from ${id}: ${change.path}`);
    changes.set(change.path, change);
  }
  return { ...proposal, files: files.flatMap(file => changes.get(file) ?? []) };
}

function joinProposals(proposals: FileProposal[]): AuthorOutput {
  const seen = new Set<string>();
  const questions = proposals.flatMap((proposal, group) => proposal.questions.flatMap(({ text }, index) => {
    const question = text.trim();
    if (!question) throw new Error("File proposal question cannot be empty.");
    if (seen.has(question)) return [];
    seen.add(question);
    return [{ id: `group-${group + 1}-question-${index + 1}`, text: question }];
  }));
  return {
    summary: proposals.map((proposal, group) => `Group ${group + 1}: ${proposal.summary}`).join("\n"),
    questions,
    document: null,
    files: questions.length ? [] : proposals.flatMap(proposal => proposal.files),
    allowedPaths: [], unitTestFiles: [], scaffoldFiles: [], checks: [],
  };
}

export async function runFileProposals(options: {
  station: ProposalStation;
  worktree: string;
  feature: string;
  groups: ProposalGroups;
  eligible: readonly string[];
  protectedPaths: readonly string[];
  source: string;
  prompt: string;
  provider: Provider;
  config: RoleConfig;
  timeoutMs: number;
  runDir: string;
  signal?: AbortSignal;
  metrics?: RunMetrics;
  onProgress?: ProviderRequest["onProgress"];
}): Promise<AuthorOutput> {
  const { worktree, feature, station, groups, eligible, protectedPaths, metrics, runDir } = options;
  if (options.signal?.aborted) throw new Error("File proposals cancelled.");
  const locations = validateOwnership(worktree, groups, eligible, protectedPaths);
  const paths = [...groups.flat(), ...protectedPaths];
  const before = digest(worktree, paths);
  const serial = options.config.provider === "deepseek";
  options.onProgress?.(`File proposals for ${station}: ${serial ? "one local worker at a time" : "two hosted workers"}.`);
  const proposals = await runWorkerPair(
    [0, 1] as const,
    { serial, label: "File proposals", signal: options.signal },
    async (index, signal) => {
      const id = `group-${index + 1}`;
      const files = groups[index];
      const prompt = `${options.prompt}
FILE PROPOSAL GROUP ${index + 1}
You are a read-only worker. Return only summary, questions, and files for your assignment. Do not write files, run checks, delegate work, or change approved scope. Use the exact assigned paths below. You may read other files for context. Treat other groups' files as unchanged while drafting. If work requires changes outside your group or an unresolved interface, ask a question. If asking questions, return no files.
Your assigned paths: ${JSON.stringify(files)}
Other group's paths: ${JSON.stringify(groups[index === 0 ? 1 : 0])}
`;
      metrics?.promptBytes.push({ role: `proposal-${id}`, sections: promptSections(prompt), total: Buffer.byteLength(prompt) });
      const value = await options.provider({
        station, role: "author", kind: "proposal", prompt, cwd: worktree,
        runDir: path.join(runDir, id), config: options.config, timeoutMs: options.timeoutMs, signal,
        onProgress: message => options.onProgress?.(`[${id}] ${message}`),
        onMetrics: value => metrics?.providers.push(value),
      });
      return orderProposal(value, files, id);
    },
  );
  const after = await timed(metrics, "source snapshot after file proposals", () => sourceFingerprint(worktree, feature));
  if (after !== options.source || digest(worktree, paths) !== before ||
      JSON.stringify(validateOwnership(worktree, groups, eligible, protectedPaths)) !== JSON.stringify(locations))
    throw new Error("Proposal provider changed repository contents outside the runner.");
  if (options.signal?.aborted) throw new Error("File proposals cancelled.");
  const output = joinProposals(proposals);
  for (const [index, proposal] of proposals.entries()) {
    const taskDir = path.join(runDir, `group-${index + 1}`);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, "validated-output.json"), JSON.stringify(proposal, null, 2));
  }
  writeFileSync(path.join(runDir, "proposal-groups.json"), JSON.stringify({ station, groups, sourceFingerprint: after, serial }, null, 2));
  writeFileSync(path.join(runDir, "validated-output.json"), JSON.stringify(output, null, 2));
  return output;
}
