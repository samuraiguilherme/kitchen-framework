import spawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  input?: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
}
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}
export function stopProcess(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32")
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let truncated = false;
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    const abort = () => {
      cancelled = true;
      stopProcess(child);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcess(child);
    }, options.timeoutMs);
    const capture = (stream: "stdout" | "stderr", data: Buffer) => {
      if (stdout.length + stderr.length + data.length > 20_000_000) {
        truncated = true;
        stopProcess(child);
        return;
      }
      if (stream === "stdout") stdout += data.toString();
      else stderr += data.toString();
    };
    child.stdout?.on("data", (data) => capture("stdout", data));
    child.stderr?.on("data", (data) => capture("stderr", data));
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.stdin?.on("error", () => {
      /* A process may exit before reading stdin. */
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        code: timedOut || cancelled || truncated ? -1 : (code ?? -1),
        stdout,
        stderr: stderr + (truncated ? "\nOutput limit exceeded" : ""),
        timedOut,
        cancelled,
      });
    });
    if (options.signal?.aborted) abort();
    child.stdin?.end(options.input ?? "");
  });
}
export async function execute(
  command: string,
  args: string[],
  cwd = process.cwd(),
): Promise<string> {
  const result = await runProcess({ command, args, cwd, timeoutMs: 120000 });
  if (result.code !== 0)
    throw new Error(
      `${command} failed (${result.code}): ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}
