import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProviderRequest } from "./types.ts";

// Restrict fail-fast to known sandbox setup failures, not ordinary tool exits or prose.
const sandboxFailure =
  /(?:Failed to create unified exec process:.*setup refresh had errors|(?:exec_command|windows_sandbox).*setup refresh had errors)/i;

export function providerProgress(request: ProviderRequest) {
  const files = {
    stdout: path.join(request.runDir, `${request.role}-events.jsonl`),
    stderr: path.join(request.runDir, `${request.role}-stderr.log`),
  };
  writeFileSync(files.stdout, "");
  writeFileSync(files.stderr, "");
  const pending = { stdout: "", stderr: "" };
  const started = Date.now();
  const report = (message: string) =>
    request.onProgress?.(
      // Strip terminal controls from provider-supplied progress text.
      // eslint-disable-next-line no-control-regex
      `[${request.station}/${request.role} ${Math.round((Date.now() - started) / 1000)}s] ${message.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500)}`,
    );
  const line = (
    stream: "stdout" | "stderr",
    raw: string,
  ): string | undefined => {
    if (request.config.provider !== "codex") return;
    if (stream === "stderr") {
      if (sandboxFailure.test(raw))
        return `Windows sandbox infrastructure failure: ${raw.trim().slice(-1500)}`;
      return;
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const item = event?.item;
    if (item?.type === "command_execution") {
      if (event.type === "item.started")
        report(`tool started: ${item.command}`);
      if (event.type === "item.completed") {
        report(`tool ${item.status}; exit=${item.exit_code}: ${item.command}`);
        if (
          (item.status === "failed" ||
            (typeof item.exit_code === "number" && item.exit_code !== 0)) &&
          sandboxFailure.test(String(item.aggregated_output))
        )
          return `Windows sandbox infrastructure failure: ${String(item.aggregated_output).slice(-1500)}`;
      }
    } else if (item?.type === "mcp_tool_call") {
      report(`tool ${event.type}: ${item.server}/${item.tool}`);
    } else if (
      event?.type === "thread.started" ||
      event?.type === "turn.started" ||
      event?.type === "turn.completed"
    ) {
      report(event.type);
    } else if (event?.type === "error" || event?.type === "turn.failed") {
      const message = JSON.stringify(event.error ?? event.message);
      report(`${event.type}: ${message}`);
      if (sandboxFailure.test(message))
        return `Windows sandbox infrastructure failure: ${message.slice(-1500)}`;
    }
  };
  return {
    report,
    capture(stream: "stdout" | "stderr", chunk: string): string | undefined {
      // Persist before notifying the terminal or stopping the process.
      appendFileSync(files[stream], chunk);
      pending[stream] += chunk;
      const lines = pending[stream].split(/\r?\n/);
      pending[stream] = lines.pop()!;
      let failure: string | undefined;
      for (const raw of lines) failure ??= line(stream, raw);
      // stderr may emit a complete error without a trailing newline.
      if (stream === "stderr") failure ??= line(stream, pending.stderr);
      return failure;
    },
    finish(): string | undefined {
      return line("stdout", pending.stdout) ?? line("stderr", pending.stderr);
    },
  };
}
