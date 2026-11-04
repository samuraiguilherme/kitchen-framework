import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { discoveryAuthor } from "./discovery.ts";
import { stationOrder } from "./domain.ts";
import { runProcess } from "./process.ts";
import { probeProvider } from "./providers.ts";
import type { ProbeContract } from "./providers.ts";
import { resolveProviderExecutable } from "./provider-executable.ts";
import {
  deepseekVersionArgs,
  deepseekSetupRole,
  readDeepSeekModels,
  deepseekModelIdentity,
} from "./deepseek.ts";
import type { CheckResult, RoleConfig } from "./types.ts";

export async function doctor(
  root: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  } = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push({
    id: "node-22",
    required: true,
    status:
      Number(process.versions.node.split(".")[0]) >= 22 ? "passed" : "failed",
    reason: process.versions.node,
  });
  const config = loadConfig(root);
  const pairs: Array<{
    config: RoleConfig;
    roles: string[];
    contracts: Partial<Record<ProbeContract, string[]>>;
    prerequisites: string[];
  }> = [];
  const addPair = (role: RoleConfig, label: string, contract: ProbeContract) => {
    const existing = pairs.find(
      (pair) =>
        pair.config.provider === role.provider &&
        pair.config.model === role.model &&
        pair.config.executable === role.executable &&
        pair.config.windowsSandbox === role.windowsSandbox &&
        JSON.stringify(pair.config.dsh) === JSON.stringify(role.dsh),
    );
    if (existing) {
      if (!existing.roles.includes(label)) existing.roles.push(label);
      const labels = (existing.contracts[contract] ??= []);
      if (!labels.includes(label)) labels.push(label);
    } else pairs.push({
      config: role, roles: [label], contracts: { [contract]: [label] }, prerequisites: [],
    });
  };
  for (const station of stationOrder) {
    const roles = config.stations[station];
    if (station !== "publish")
      addPair(
        roles?.author ?? config.providers.author,
        roles?.author ? `stations.${station}.author` : "providers.author",
        "author",
      );
    if (roles?.reviewEnabled)
      addPair(
        roles.review ?? config.providers.review,
        roles.review ? `stations.${station}.review` : "providers.review",
        "review",
      );
  }
  if (config.discovery?.enabled)
    addPair(
      discoveryAuthor(config),
      config.discovery.author ? "discovery.author" : config.stations.plan?.author ? "stations.plan.author" : "providers.author",
      "discovery",
    );
  const claudeRoles: Array<{
    config: RoleConfig;
    label: string;
    active: boolean;
  }> = [];
  const addClaudeRole = (role: RoleConfig | undefined, label: string) => {
    if (role?.provider === "claude")
      claudeRoles.push({
        config: role,
        label,
        active: pairs.some(pair => pair.roles.includes(label)),
      });
  };
  for (const role of ["author", "review"] as const) {
    addClaudeRole(config.providers[role], `providers.${role}`);
    for (const station of stationOrder)
      addClaudeRole(config.stations[station]?.[role], `stations.${station}.${role}`);
  }
  addClaudeRole(config.discovery?.author, "discovery.author");
  const claudeRequired = claudeRoles.some(role => role.active);
  const configSources = ["kitchen.config.json", "kitchen.config.local.json"]
    .map(file => path.join(root, file))
    .filter(file => existsSync(file));
  const claudeConfiguration = claudeRoles.map(role =>
    `${role.label} (${role.active ? "active" : "inactive"}; model=${role.config.model ?? "CLI default (inherited)"}; executable=${resolveProviderExecutable("claude", role.config.executable)})`,
  );
  results.push({
    id: "claude-configuration",
    required: claudeRequired,
    status: claudeRequired ? "passed" : "unverified",
    reason: [
      `Project ${root}; configuration=${configSources.join(", ") || "built-in defaults"}; default author=${config.providers.author.provider}`,
      ...claudeConfiguration,
      ...(claudeRequired ? [] : [
        "No active role uses Claude. Setup diagnostics are optional; select providers.author.provider=claude or enable a Claude reviewer to verify its model.",
      ]),
    ].join("; "),
  });
  const packageFile = path.join(root, "package.json");
  const localPairs = pairs.filter(
    (pair) => pair.config.provider === "deepseek",
  );
  const localRequired = localPairs.length > 0;
  const localRoles = localRequired
    ? localPairs.map((pair) => pair.config)
    : [deepseekSetupRole()];
  results.push({
    id: "deepseek-configuration",
    required: localRequired,
    status: localRequired ? "passed" : "unverified",
    reason: localRequired
      ? `Project ${root}; DeepSeek selected for ${localPairs.flatMap((pair) => pair.roles).join(", ")}.`
      : `Project ${root}; default author=${config.providers.author.provider}; no active role uses DeepSeek. Select provider deepseek in kitchen.config.local.json or run pwsh -File "${fileURLToPath(new URL("../scripts/setup-deepseek.ps1", import.meta.url))}" -Root "${root}". Setup diagnostics below do not select it or generate with an unused model.`,
  });
  const endpoints = [...new Set(localRoles.map((role) => role.dsh!.baseURL))];
  // Inventory calls overlap CLI checks, but their rejections are observed immediately.
  const inventories = Promise.allSettled(
    endpoints.map((baseURL) =>
      readDeepSeekModels(
        localRoles.find((role) => role.dsh!.baseURL === baseURL)!,
        Math.min(config.providers.timeoutMs, localRequired ? 5000 : 2000),
        options.signal,
      ),
    ),
  );
  const packageManager = existsSync(packageFile)
    ? JSON.parse(readFileSync(packageFile, "utf8")).packageManager
    : undefined;
  const pinned =
    typeof packageManager === "string" && packageManager.startsWith("pnpm@")
      ? packageManager.slice(5).split("+")[0]
      : undefined;
  const needsPnpm =
    pinned !== undefined ||
    Object.values(config.profiles).some((profile) =>
      [
        profile.command,
        profile.setup?.command,
        profile.preview?.command,
        profile.preview?.build.command,
      ].includes("pnpm"),
    );
  const checks: Array<{
    id: string;
    command: string;
    args: string[];
    required: boolean;
    timeoutMs?: number;
  }> = [
    ...(needsPnpm
      ? [{ id: "pnpm", command: "pnpm", args: ["--version"], required: true }]
      : []),
    { id: "git", command: "git", args: ["--version"], required: true },
    {
      id: "base",
      command: "git",
      args: ["rev-parse", "--verify", config.base],
      required: true,
    },
    {
      id: "github-auth",
      command: "gh",
      args: ["api", "user", "--jq", ".login", "--hostname", "github.com"],
      required: false,
    },
  ];
  const executables: Array<{
    provider: RoleConfig["provider"];
    command: string;
    prefix: string;
    version?: string;
  }> = [];
  const addExecutable = (role: RoleConfig, required: boolean) => {
    const provider = role.provider;
    const command = resolveProviderExecutable(provider, role.executable);
    let entry = executables.find(
      (e) =>
        e.provider === provider &&
        e.command === command &&
        e.version === role.dsh?.version,
    );
    if (!entry) {
      const count = executables.filter((e) => e.provider === provider).length;
      entry = {
        provider,
        command,
        prefix:
          (provider === "deepseek" ? "dsh" : provider) +
          (count ? `-${count + 1}` : ""),
        version: role.dsh?.version,
      };
      executables.push(entry);
      checks.push({
        id: `${entry.prefix}-cli`,
        command,
        args:
          provider === "deepseek"
            ? deepseekVersionArgs(role)
            : ["--version"],
        required,
      });
      if (provider !== "deepseek")
        checks.push({
          id: `${entry.prefix}-auth`,
          command,
          args:
            provider === "codex"
              ? ["login", "status"]
              : ["auth", "status", "--json"],
          required,
        });
    }
    return entry;
  };
  // Active roles register first so shared CLI/auth checks remain required.
  for (const pair of pairs) {
    const entry = addExecutable(pair.config, true);
    pair.prerequisites = [
      `${entry.prefix}-cli`,
      ...(pair.config.provider === "deepseek" ? [] : [`${entry.prefix}-auth`]),
    ];
  }
  const claudeSetupRoles = claudeRoles.filter(role => role.label !== "stations.publish.author");
  for (const role of claudeSetupRoles.length
    ? claudeSetupRoles.map(role => role.config)
    : [{ provider: "claude" } as const])
    addExecutable(role, false);
  if (!claudeRequired)
    results.push({
      id: "claude-probe",
      required: false,
      status: "unverified",
      reason: "Generation not run: no active role uses Claude. Select providers.author.provider=claude or enable a Claude reviewer, then rerun doctor to verify its configured model and response contract.",
    });
  if (!localRequired) {
    const role = localRoles[0]!;
    const command = resolveProviderExecutable("deepseek");
    executables.push({
      provider: "deepseek",
      command,
      prefix: "dsh",
      version: role.dsh!.version,
    });
    checks.push({
      id: "dsh-cli",
      command,
      args: deepseekVersionArgs(role),
      required: false,
      timeoutMs: 3000,
    });
  }
  const settled = await Promise.allSettled(
    checks.map(async (check) => {
      const result = await runProcess({
        ...check,
        cwd: root,
        timeoutMs: check.timeoutMs ?? 10000,
        signal: options.signal,
      });
      const failed =
        result.code !== 0 ||
        (/^dsh(?:-\d+)?-cli$/.test(check.id) &&
          result.stdout.trim() !==
            executables.find((entry) => `${entry.prefix}-cli` === check.id)
              ?.version) ||
        (check.id === "pnpm" &&
          pinned !== undefined &&
          result.stdout.trim() !== pinned);
      let reason = failed
        ? result.timedOut
          ? "Timed out; inspect CLI availability/authentication."
          : "Command unavailable, authentication failed, or pinned version differs."
        : result.stdout.trim().slice(0, 200) || "Available";
      let status = failed
        ? check.required
          ? "failed"
          : "unverified"
        : "passed";
      if (/^dsh(?:-\d+)?-cli$/.test(check.id)) {
        const version = executables.find(
          (entry) => `${entry.prefix}-cli` === check.id,
        )!.version;
        reason = failed
          ? `DSH ${version} is unavailable in the npm cache or reported another version. Prewarm with npx --yes @deepseek-ai/dsh@${version} --version.`
          : `DeepSeek Harness ${version}; cached offline runtime verified.`;
      }
      if (check.id.endsWith("-cli")) reason = `${check.command}: ${reason}`;
      if (
        check.id === "github-auth" &&
        result.code === 0 &&
        config.github.account &&
        result.stdout.trim() !== config.github.account
      ) {
        status = "failed";
        reason = "Active account differs from configured intended username.";
      }
      if (/^claude(?:-\d+)?-auth$/.test(check.id) && result.code === 0) {
        try {
          const loggedIn = JSON.parse(result.stdout).loggedIn;
          if (loggedIn === false) {
            status = check.required ? "failed" : "unverified";
            reason = "Claude is not logged in. Authenticate the selected CLI with auth login.";
          } else if (loggedIn !== true) {
            status = "unverified";
            reason = "Unknown Claude auth response.";
          }
        } catch {
          status = "unverified";
          reason = "Unknown Claude auth response.";
        }
      }
      return { id: check.id, required: check.required, status, reason };
    }),
  );
  for (let index = 0; index < settled.length; index++) {
    const result = settled[index]!;
    results.push(
      result.status === "fulfilled"
        ? result.value
        : {
            id: checks[index]!.id,
            required: checks[index]!.required,
            status: "failed",
            reason: "Diagnostic failed.",
          },
    );
  }
  const runDir = path.join(root, ".kitchen", "doctor", randomUUID());
  {
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported = major! > 24 || (major === 24 && minor! >= 9);
    results.push({
      id: "deepseek-node",
      required: localRequired,
      status: supported ? "passed" : localRequired ? "failed" : "unverified",
      reason: `DSH requires Node >=24.9; current ${process.versions.node}`,
    });
    for (const pair of pairs)
      if (pair.config.provider === "deepseek")
        pair.prerequisites.push("deepseek-node");
  }
  const inventoryResults = await inventories;
  const servers = new Map<string, { id: string; models?: unknown[] }>();
  for (const [index, baseURL] of endpoints.entries()) {
    const result = inventoryResults[index]!;
    const id = `ollama-server${index ? `-${index + 1}` : ""}`;
    const available = result.status === "fulfilled";
    results.push({
      id,
      required: localRequired,
      status: available ? "passed" : localRequired ? "failed" : "unverified",
      reason: available
        ? `Ollama reachable at ${baseURL}; ${result.value.length} installed model(s).`
        : `Ollama unavailable at ${baseURL}: ${options.signal?.aborted ? "cancelled" : result.reason instanceof Error ? result.reason.message : String(result.reason)}. Start Ollama and complete local model setup.`,
    });
    servers.set(baseURL, {
      id,
      ...(available ? { models: result.value } : {}),
    });
  }
  for (const [index, role] of localRoles.entries()) {
    const id = `deepseek-local${index ? `-${index + 1}` : ""}`;
    const server = servers.get(role.dsh!.baseURL)!;
    const check: CheckResult = {
      id,
      required: localRequired,
      status: "unverified",
    };
    if (!server.models)
      check.reason = `model=${role.model}; inventory skipped because ${server.id} did not pass.`;
    else
      try {
        const identity = deepseekModelIdentity(role, server.models);
        check.status = "passed";
        check.reason = `model=${identity.model}; endpoint=${identity.baseURL}; digest=${identity.digest}; pin=${role.dsh!.expectedModelDigest ? "matched" : "not configured"}; contextWindow=${role.dsh!.contextWindow}; maxTokens=${role.dsh!.maxTokens}.`;
      } catch (error) {
        check.status = localRequired ? "failed" : "unverified";
        const installed = server.models.flatMap((model) =>
          model &&
          typeof model === "object" &&
          "name" in model &&
          typeof model.name === "string" &&
          /deepseek/i.test(model.name)
            ? [model.name]
            : [],
        );
        check.reason = `${error instanceof Error ? error.message : String(error)} Installed DeepSeek models: ${installed.join(", ") || "none"}. Expected model=${role.model}.`;
      }
    results.push(check);
    localPairs[index]?.prerequisites.push(server.id, id);
  }
  if (!localRequired)
    results.push({
      id: "deepseek-probe",
      required: false,
      status: "unverified",
      reason:
        "Generation not run: DeepSeek is not selected for an active role. Configure kitchen.config.local.json, then rerun doctor to validate its final JSON schema.",
    });
  for (const [index, pair] of pairs.entries()) {
    const contracts = Object.keys(pair.contracts) as ProbeContract[];
    for (const [contractIndex, contract] of contracts.entries()) {
      const label = [
        `${pair.config.provider} model=${pair.config.model ?? "CLI default (inherited)"}`,
        ...(pair.config.provider === "codex"
          ? [`windowsSandbox=${pair.config.windowsSandbox ?? "CLI default (inherited)"}`]
          : []),
        `contract=${contract}`,
        `executable=${resolveProviderExecutable(pair.config.provider, pair.config.executable)}`,
        pair.contracts[contract]!.join(", "),
      ].join("; ");
      const check: CheckResult = {
        id: `${pair.config.provider}-model-${index + 1}${contractIndex ? `-${contract}` : ""}`,
        required: true,
        status: "unverified",
      };
      const unavailable = pair.prerequisites.filter(
        (id) => results.find((r) => r.id === id)?.status !== "passed",
      );
      if (unavailable.length)
        check.reason = `${label}; request skipped because ${unavailable.join(", ")} did not pass.`;
      else if (options.signal?.aborted)
        check.reason = `${label}; cancelled before request.`;
      else {
        const probeDir = path.join(runDir, check.id);
        options.onProgress?.(
          `Checking ${label} with a small ${pair.config.provider === "deepseek" ? "local Ollama request" : "hosted request (uses model quota)"}.`,
        );
        try {
          await probeProvider(
            pair.config,
            probeDir,
            Math.min(
              config.providers.timeoutMs,
              pair.config.provider === "deepseek" ? 180000 : 60000,
            ),
            options.signal,
            contract,
          );
          check.status = "passed";
          check.reason = `${label}; structured request succeeded.`;
        } catch (error) {
          check.status = "failed";
          check.reason = `${label}; ${error instanceof Error ? error.message : String(error)}`;
        }
        const role = contract === "review" ? "review" : "author";
        const evidence = path.join(probeDir, `${role}-process.json`);
        if (existsSync(evidence)) check.evidence = evidence;
      }
      results.push(check);
    }
  }
  results.push({
    id: "github-intended-account",
    required: false,
    status: config.github.account ? "passed" : "unverified",
    reason:
      config.github.account ??
      "Set an exact intended username before publishing.",
  });
  results.push({
    id: "check-profiles",
    required: false,
    status: Object.keys(config.profiles).length ? "passed" : "unverified",
    reason:
      Object.keys(config.profiles).join(", ") ||
      "Run kitchen init, then configure project-specific check profiles in kitchen.config.json before the test plan.",
  });
  return results;
}
