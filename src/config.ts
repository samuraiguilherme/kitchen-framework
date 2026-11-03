import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Config, Profile, RoleConfig } from "./types.ts";
import { stationOrder } from "./domain.ts";

export function baseBranch(base: string): string {
  const branch =
    typeof base === "string"
      ? base.replace(/^(?:refs\/remotes\/origin\/|refs\/heads\/|origin\/)/, "")
      : "";
  if (
    !branch ||
    branch === "@" ||
    branch === "HEAD" ||
    branch.startsWith("-") ||
    branch.startsWith("refs/") ||
    /[\s~^:?*[\\]/.test(branch) ||
    [...branch].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.split("/").some(
      (part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"),
    )
  )
    throw new Error(
      "Base must name a local branch or an origin/<branch> ref (for example origin/main).",
    );
  return branch;
}

export function loadConfig(root: string): Config {
  const read = (name: string): Partial<Config> => {
    const file = path.join(root, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  };
  const shared = read("kitchen.config.json");
  const local = read("kitchen.config.local.json");
  const config: Config = {
    version: 1,
    base: "origin/develop",
    ...shared,
    ...local,
    github: { repository: "", ...shared.github, ...local.github },
    providers: {
      timeoutMs: 600000,
      ...shared.providers,
      ...local.providers,
      author: {
        provider: "codex",
        ...shared.providers?.author,
        ...local.providers?.author,
      },
      review: {
        provider: "claude",
        ...shared.providers?.review,
        ...local.providers?.review,
      },
    },
    stations: { ...shared.stations, ...local.stations },
    profiles: { ...shared.profiles, ...local.profiles },
  };
  for (const station of stationOrder) {
    const overrides = local.stations?.[station];
    if (!overrides) continue;
    const original = shared.stations?.[station];
    const pair = { ...original, ...overrides };
    for (const role of ["author", "review"] as const) {
      if (overrides[role])
        pair[role] = {
          ...(original?.[role] ?? config.providers[role]),
          ...overrides[role],
        };
    }
    config.stations[station] = pair;
  }
  if (config.version !== 1) throw new Error("Supported config version is 1.");
  baseBranch(config.base);
  const role = (value: RoleConfig) => {
    if (
      !value ||
      !["codex", "claude"].includes(value.provider) ||
      (value.model !== undefined &&
        (typeof value.model !== "string" || !value.model.trim())) ||
      (value.executable !== undefined &&
        typeof value.executable !== "string") ||
      (value.windowsSandbox !== undefined &&
        (value.provider !== "codex" ||
          !["elevated", "unelevated"].includes(value.windowsSandbox)))
    )
      throw new Error("Invalid provider configuration.");
  };
  role(config.providers.author);
  role(config.providers.review);
  if (
    !Number.isFinite(config.providers.timeoutMs) ||
    config.providers.timeoutMs < 100 ||
    config.providers.timeoutMs > 3600000
  )
    throw new Error("Provider timeout must be finite, between 100ms and 1h.");
  for (const [station, pair] of Object.entries(config.stations)) {
    if (!stationOrder.includes(station as (typeof stationOrder)[number]))
      throw new Error(`Unknown station ${station}`);
    if (
      pair?.reviewEnabled !== undefined &&
      typeof pair.reviewEnabled !== "boolean"
    )
      throw new Error(`Station ${station} reviewEnabled must be a boolean.`);
    if (pair?.author) role(pair.author);
    if (pair?.review) role(pair.review);
  }
  for (const [name, value] of Object.entries(config.profiles))
    validateProfile(name, value);
  if (
    config.discovery !== undefined &&
    (!config.discovery ||
      typeof config.discovery !== "object" ||
      (config.discovery.enabled !== undefined &&
        typeof config.discovery.enabled !== "boolean"))
  )
    throw new Error("Discovery enabled must be a boolean.");
  return config;
}
function validateProfile(name: string, value: Profile): void {
  if (
    (value.parallelSafe !== undefined &&
      typeof value.parallelSafe !== "boolean") ||
    (value.resourceGroup !== undefined &&
      (typeof value.resourceGroup !== "string" || !value.resourceGroup.trim()))
  )
    throw new Error(`Profile ${name} has invalid concurrency settings.`);
  if (
    !/^[a-z0-9-]+$/.test(name) ||
    !["unit", "integration", "browser", "command", "manual"].includes(
      value.kind,
    )
  )
    throw new Error(`Invalid check profile ${name}`);
  if (value.kind === "manual") return;
  if (
    value.setup &&
    (value.setup.command !== "pnpm" ||
      !value.setup.args.includes("install") ||
      !value.setup.args.includes("--offline") ||
      !value.setup.args.includes("--frozen-lockfile") ||
      !value.setup.args.includes("--ignore-scripts") ||
      !Number.isFinite(value.setup.timeoutMs) ||
      value.setup.timeoutMs < 100 ||
      value.setup.timeoutMs > 3600000)
  )
    throw new Error(
      `Profile ${name} setup must use a finite offline frozen pnpm install with scripts disabled.`,
    );
  if (
    !value.command ||
    !Array.isArray(value.args) ||
    !value.args.every((a) => typeof a === "string") ||
    !Number.isFinite(value.timeoutMs) ||
    value.timeoutMs! < 100 ||
    value.timeoutMs! > 3600000
  )
    throw new Error(`Profile ${name} requires a finite command and timeout.`);
  if (
    value.args.some((a) =>
      ["dev", "watch", "--watch", "--watchAll", "--passWithNoTests"].includes(
        a,
      ),
    )
  )
    throw new Error(
      `Profile ${name} must be finite and cannot accept zero tests.`,
    );
  if (
    !["vitest-json", "playwright-json", "exit-code"].includes(
      value.parser ?? "",
    )
  )
    throw new Error(`Profile ${name} requires an explicit parser.`);
  if (
    ["unit", "integration", "browser"].includes(value.kind) &&
    value.parser === "exit-code"
  )
    throw new Error(`Behavioral profile ${name} requires test counts.`);
  if (
    value.kind === "browser" &&
    (!value.preview?.build || !value.args.some((a) => a.includes("{baseUrl}")))
  )
    throw new Error(
      `Browser profile ${name} requires a candidate build, preview, and explicit {baseUrl} targeting.`,
    );
}
