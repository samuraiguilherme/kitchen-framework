import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { stopProcess } from "../../src/process.ts";

export interface Capability { id: string; passed: boolean; reason?: string }

export async function checkCapabilities(
  probes: Record<string, () => void | Promise<void>>,
): Promise<Capability[]> {
  const results: Capability[] = [];
  for (const [id, probe] of Object.entries(probes)) {
    try { await probe(); results.push({ id, passed: true }); }
    catch (error) { results.push({ id, passed: false, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

export async function integrationEnvironment(): Promise<Capability[]> {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-capabilities-"));
  try {
    return await checkCapabilities({
      "loopback-http": async () => {
        const server = createServer((_req, res) => res.end("kitchen-ready"));
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("No loopback port allocated.");
          const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(1500) });
          if (await response.text() !== "kitchen-ready") throw new Error("Loopback response did not match.");
        } finally {
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      },
      "directory-symlink": () => {
        const target = path.join(root, "target");
        mkdirSync(target);
        symlinkSync(target, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
      },
      "process-tree-termination": async () => {
        const script = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(c.pid);setInterval(()=>{},1000);";
        const child = spawn(process.execPath, ["-e", script], {
          detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
        });
        let descendant: number | undefined;
        let closed = false;
        child.once("close", () => { closed = true; });
        try {
          descendant = await new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Child startup exceeded 3 seconds.")), 3000);
            child.once("error", error => { clearTimeout(timer); reject(error); });
            child.stdout.once("data", data => {
              clearTimeout(timer);
              const pid = Number(String(data).trim());
              if (!Number.isSafeInteger(pid) || pid <= 0) reject(new Error("No descendant PID."));
              else resolve(pid);
            });
          });
          stopProcess(child);
          const deadline = Date.now() + 1500;
          let alive = true;
          while (Date.now() < deadline) {
            try { process.kill(descendant, 0); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              alive = false;
            }
            if (closed && !alive) return;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          throw new Error("Process-tree termination is unavailable; subprocess timeout tests would hang.");
        } finally {
          // Bounded cleanup even when the OS refuses the tree-kill operation.
          if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* Already gone or denied. */ } }
          child.kill("SIGKILL");
          child.stdout.destroy();
          child.unref();
        }
      },
      "git-local-transport": async () => {
        const run = promisify(execFile);
        const options = { cwd: root, timeout: 3000, windowsHide: true,
          env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" } };
        const remote = path.join(root, "remote.git");
        await run("git", ["init", "--bare", "--quiet", remote], options);
        await run("git", ["ls-remote", remote], options);
      },
    });
  } finally {
    // root is the exact directory returned by mkdtemp, never a caller path.
    rmSync(root, { recursive: true, force: true });
  }
}
