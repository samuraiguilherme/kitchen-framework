import spawn from "cross-spawn";
import { createInterface } from "node:readline";
import { codexCliEnvironment, resolveProviderExecutable } from "../../src/provider-executable.ts";
import type { RoleConfig } from "../../src/types.ts";

interface Window {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

interface RateLimit {
  limitId: string;
  primary: Window | null;
  secondary: Window | null;
  spendControlReached?: boolean;
}

export function codexQuota(role: RoleConfig, cwd: string) {
  return new Promise<{
    capturedAt: string;
    ordinaryUsageAllowed?: boolean;
    buckets: RateLimit[];
  }>((resolve, reject) => {
    const child = spawn(resolveProviderExecutable("codex", role.executable), ["app-server", "--listen", "stdio://"], {
      cwd, env: { ...process.env, ...codexCliEnvironment() }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    const stream = createInterface({ input: child.stdout! });
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stream.close();
      child.kill();
      if (error) reject(error);
    };
    const timer = setTimeout(() => finish(new Error("Codex quota query timed out.")), 20000);
    const send = (message: object) => child.stdin!.write(JSON.stringify(message) + "\n");
    child.stdin!.on("error", () => finish(new Error("Codex quota query connection closed.")));
    child.on("error", finish);
    child.on("close", code => finish(new Error(`Codex quota query exited (${code}).`)));
    stream.on("line", line => {
      try {
        const event = JSON.parse(line);
        if (event.id === 1 && event.result) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: {} });
        }
        if (event.id !== 2 && !(event.id === 1 && event.error)) return;
        if (!event.result?.rateLimits) throw new Error(`Codex did not return a quota snapshot (${event.error?.code ?? "missing rate limits"}).`);
        const { rateLimits, rateLimitsByLimitId, ordinaryUsageAllowed } = event.result;
        const buckets: RateLimit[] = Object.values(rateLimitsByLimitId ?? { [rateLimits.limitId]: rateLimits });
        const window = (value: Window | null): Window | null => value ? {
          usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt,
        } : null;
        resolve({ capturedAt: new Date().toISOString(), ordinaryUsageAllowed,
          buckets: buckets.map(({ limitId, primary, secondary, spendControlReached }) => ({
            limitId, primary: window(primary), secondary: window(secondary), spendControlReached,
          })) });
        finish();
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "kitchen-qualification", title: "Kitchen qualification", version: "0.1.0" } } });
  });
}
