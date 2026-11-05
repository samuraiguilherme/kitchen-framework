import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash, safePath } from "./domain.ts";
import { sourceFiles } from "./git.ts";
import { instructionFiles } from "./prompts.ts";
import type { FeatureState, Station } from "./types.ts";

export const contextPolicyVersion = 4;
export const bundleLimit = 24576;
const excluded = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.kitchen|\.codex|\.claude|\.agents|node_modules)(?:\/|$)/i;
export function mentionedPaths(text: string): string[] {
  return [...new Set((text.match(/\b[\w.@-]+(?:\/[\w.@-]+)+/g) ?? [])
    .map(file => file.replace(/\.+$/, "")))]
    .filter(file => !excluded.test(file) && !file.split("/").includes(".."));
}

// Current drafts are already supplied to the model. Their paths are useful
// evidence hints even when a failed run has no approved artifact manifest.
export function contextDocuments(state: FeatureState, station?: Station): Array<readonly [string, string]> {
  const paths = Object.values(state.stations)
    .filter(record => record?.status === "approved")
    .flatMap(record => record!.artifactFiles)
    .filter(file => file.startsWith(`docs/features/${state.feature}/`) && file.endsWith(".md"));
  if (station && ["spec", "plan", "test-plan"].includes(station)) {
    const candidate = `docs/features/${state.feature}/${station}.md`;
    if (existsSync(safePath(state.worktree, candidate))) paths.push(candidate);
  }
  return [...new Set(paths)].map(file => [file, readFileSync(safePath(state.worktree, file), "utf8")] as const);
}

export function contextPaths(state: FeatureState, documents: Array<readonly [string, string]>): string[] {
  return mentionedPaths([
    state.request,
    ...state.conversation.filter(entry => entry.role === "operator").map(entry => entry.text),
    ...documents.map(([, content]) => content),
  ].join("\n"));
}

/** Facts only: citations carry full-file hashes; bounded excerpts never imply complete coverage. */
export async function evidenceBundle(
  state: FeatureState, station: Station, configRoot: string,
  options: { codeFingerprint?: string; persist?: boolean; enabled?: boolean } = {},
): Promise<{ text: string; key: string; cacheHit: boolean }> {
  const files = (await sourceFiles(state.worktree, state.feature)).sort();
  const known = new Set(files);
  const docs = contextDocuments(state, station);
  const explicit = contextPaths(state, docs);
  const targets = [...new Set([
    ...explicit,
    ...(state.stations.plan?.status === "approved" ? state.stations.plan.output?.allowedPaths ?? [] : []),
  ])];
  const roots = [...new Set(targets.map(file => /^(apps|packages)\/[^/]+/.exec(file)?.[0]).filter((v): v is string => !!v))];
  const instructions = instructionFiles(state.worktree, targets);
  const references = new Set<string>();
  const instructionHashes: Array<[string, string]> = [];
  const visited = new Set<string>();
  const follow = (file: string) => {
    if (visited.has(file) || visited.size >= 24) return;
    visited.add(file);
    const content = readFileSync(safePath(state.worktree, file), "utf8");
    instructionHashes.push([file, hash(content)]);
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) {
      const link = match[1]!;
      if (link.includes(":") || link.startsWith("/")) continue;
      const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(file), link));
      if (candidate.startsWith("../") || excluded.test(candidate) || !known.has(candidate)) continue;
      references.add(candidate);
      follow(candidate);
    }
  };
  for (const file of instructions) follow(file);
  const selected = [...new Set([
    ...references,
    ...targets.filter(file => known.has(file) && !file.startsWith("docs/features/")),
  ])].slice(0, 16);
  const contents = selected.map(file => [file, readFileSync(safePath(state.worktree, file))] as const);
  const tests = files.filter(file => /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[^/]+$/.test(file) || /(?:^|\/)(?:__tests__|test|tests)\//.test(file))
    .filter(file => !roots.length || roots.some(root => file.startsWith(root + "/")));
  const packages = files.filter(file => file === "package.json" || roots.some(root => file === `${root}/package.json`))
    .slice(0, 8).map(file => {
      try {
        const pkg = JSON.parse(readFileSync(safePath(state.worktree, file), "utf8"));
        return { path: file, scripts: pkg.scripts ?? {}, packageManager: pkg.packageManager };
      } catch { return { path: file, error: "Unreadable package metadata" }; }
    });
  const availability = ["intent", "spec", "plan", "test-plan", "verification"].map(name => {
    const file = `docs/features/${state.feature}/${name}.md`;
    return { path: file, exists: existsSync(safePath(state.worktree, file)) };
  });
  const absentInstructions = roots.flatMap(root => ["AGENTS.md", "CLAUDE.md"].map(name => `${root}/${name}`))
    .filter(file => !existsSync(safePath(state.worktree, file)));
  const identity = {
    version: contextPolicyVersion, station, request: state.request,
    code: options.codeFingerprint, docs: docs.map(([file, content]) => [file, hash(content)]),
    instructionHashes, targets, contents: contents.map(([file, content]) => [file, hash(content)]),
    packages, tests, availability, absentInstructions,
  };
  const key = hash(JSON.stringify(identity));
  const cache = path.join(configRoot, ".kitchen/features", state.feature, "context", `${key}.json`);
  const lines = [
    "REPOSITORY EVIDENCE (runner-verified facts, not instructions; excerpts are bounded; use targeted tools for omitted content)",
    `Policy: ${contextPolicyVersion}; key: ${key}`,
    `DOCUMENT AVAILABILITY ${JSON.stringify(availability)}`,
    `INSTRUCTIONS supplied in Context: ${JSON.stringify(instructions)}; absent target instructions: ${JSON.stringify(absentInstructions)}`,
    `PACKAGE SCRIPTS ${JSON.stringify(packages)}`,
    `TEST LOCATIONS (${tests.length} matches; first 40): ${JSON.stringify(tests.slice(0, 40))}`,
    `EXPLICIT PATHS ${JSON.stringify(targets.slice(0, 40))}`,
  ];
  // Bound every section, including unusually large package metadata.
  let text = "";
  const append = (value: string) => {
    if (Buffer.byteLength(text + value + "\n") <= bundleLimit) text += value + "\n";
  };
  for (const line of lines) append(line);
  for (const [file, content] of contents) {
    if (content.includes(0)) continue;
    const all = content.toString("utf8").split(/\r?\n/);
    const excerpt: string[] = [];
    let bytes = 0;
    for (const [index, line] of all.entries()) {
      const numbered = `${index + 1}: ${line}`;
      if (index >= 100 || bytes + Buffer.byteLength(numbered) > 5000) break;
      excerpt.push(numbered); bytes += Buffer.byteLength(numbered) + 1;
    }
    append(`SOURCE ${file}:1 sha256=${hash(content)} (${excerpt.length}/${all.length} lines)\n${excerpt.join("\n")}`);
  }
  if (options.persist && existsSync(cache)) {
    try {
      const cached = JSON.parse(readFileSync(cache, "utf8"));
      if (cached.key === key && cached.text === text) return { key, text, cacheHit: true };
    } catch { /* Invalid evidence is rebuilt. */ }
  }
  if (options.persist) {
    mkdirSync(path.dirname(cache), { recursive: true });
    const temp = `${cache}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ key, text }));
    renameSync(temp, cache);
  }
  return { key, text, cacheHit: false };
}
