import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ProviderName } from "./types.ts";

export function resolveProviderExecutable(
  provider: ProviderName,
  executable?: string,
  searchPath = process.env.PATH ?? "",
): string {
  if (provider === "deepseek")
    return executable ?? (process.platform === "win32" ? "npx.cmd" : "npx");
  if (
    provider !== "codex" ||
    !executable ||
    existsSync(executable) ||
    !path.isAbsolute(executable) ||
    !/[\\/]OpenAI[\\/]Codex[\\/]bin[\\/][a-f0-9]{16}[\\/]codex\.exe$/i.test(
      executable,
    )
  )
    return executable ?? provider;

  // Desktop updates replace the runtime directory. Resolve at launch rather
  // than rewriting config, which would invalidate existing station approvals.
  const bin = path.dirname(path.dirname(executable));
  const candidates: Array<{ file: string; modified: number }> = [];
  try {
    for (const entry of readdirSync(bin, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{16}$/i.test(entry.name)) continue;
      const file = path.join(bin, entry.name, "codex.exe");
      try {
        const info = statSync(file);
        if (info.isFile()) candidates.push({ file, modified: info.mtimeMs });
      } catch {
        // An old or partially installed runtime may have no executable.
      }
    }
  } catch {
    return executable;
  }

  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const file = path.resolve(directory.replace(/^"|"$/g, ""), "codex.exe");
    const active = candidates.find(
      (candidate) => path.relative(candidate.file, file) === "",
    );
    if (active) return active.file;
  }
  candidates.sort(
    (a, b) => b.modified - a.modified || a.file.localeCompare(b.file),
  );
  return candidates[0]?.file ?? executable;
}
