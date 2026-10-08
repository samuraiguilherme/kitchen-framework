import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Config, Profile, RoleConfig } from "./types.ts";
import { stationOrder } from "./domain.ts";

export function loadConfig(root: string): Config {
  const file = path.join(root, "kitchen.config.json");
  const input = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const config: Config = {
    version: 1,
    base: "origin/develop",
    github: { repository: "" },
    providers: {
      author: { provider: "codex" },
      review: { provider: "claude" },
      timeoutMs: 600000,
    },
    stations: {},
    profiles: {},
    ...input,
  };
  config.providers = {
    author: { provider: "codex" },
    review: { provider: "claude" },
    timeoutMs: 600000,
    ...input.providers,
  };
  if (config.version !== 1 || config.base !== "origin/develop")
    throw new Error(
      "Supported config version is 1, base must be origin/develop.",
    );
  const role = (value: RoleConfig) => {
    if (
      !value ||
      !["codex", "claude"].includes(value.provider) ||
      (value.model !== undefined && typeof value.model !== "string") ||
      (value.executable !== undefined && typeof value.executable !== "string")
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
    if (pair?.author) role(pair.author);
    if (pair?.review) role(pair.review);
  }
  for (const [name, value] of Object.entries(config.profiles))
    validateProfile(name, value);
  return config;
}
function validateProfile(name: string, value: Profile): void {
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
