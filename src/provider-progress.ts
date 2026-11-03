import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { ProviderMetrics, ProviderRequest } from "./types.ts";
import { deepseekEventFailure } from "./deepseek.ts";

// Restrict fail-fast to known sandbox setup failures, not ordinary tool exits or prose.
const sandboxFailure =
  /(?:Failed to create unified exec process:.*setup refresh had errors|(?:exec_command|windows_sandbox).*setup refresh had errors)/i;

export function providerProgress(request: ProviderRequest, probe = false) {
  const files = {
    stdout: path.join(request.runDir, `${request.role}-events.jsonl`),
    stderr: path.join(request.runDir, `${request.role}-stderr.log`),
  };
  writeFileSync(files.stdout, "");
  writeFileSync(files.stderr, "");
  const timingsFile = path.join(
    request.runDir,
    `${request.role}-timing-events.jsonl`,
  );
  writeFileSync(timingsFile, "");
  const pending = { stdout: "", stderr: "" };
  const started = performance.now();
  const metrics: ProviderMetrics = { durationMs: 0, toolCount: 0 };
  const tools = new Set<string>();
  let deepseekSteps = 0;
  let incompleteUsage = false;
  const report = (message: string) =>
    request.onProgress?.(
      // Strip terminal controls from provider-supplied progress text.
      // eslint-disable-next-line no-control-regex
      `[${request.station}/${request.role} ${Math.round((performance.now() - started) / 1000)}s] ${message.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500)}`,
    );
  const line = (
    stream: "stdout" | "stderr",
    raw: string,
  ): string | undefined => {
    if (request.config.provider === "claude") return;
    if (stream === "stderr") {
      if (request.config.provider === "codex" && sandboxFailure.test(raw))
        return `Windows sandbox infrastructure failure: ${raw.trim().slice(-1500)}`;
      return;
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      if (request.config.provider === "deepseek" && raw.trim())
        return "Invalid JSON in DSH event stream.";
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event))
      return request.config.provider === "deepseek"
        ? "Invalid DSH stream event."
        : undefined;
    const item = event?.item;
    const elapsedMs = performance.now() - started;
    metrics.firstEventMs ??= elapsedMs;
    appendFileSync(
      timingsFile,
      JSON.stringify({
        elapsedMs,
        type: event.type,
        itemType: item?.type,
        itemId: item?.id,
      }) + "\n",
    );
    if (request.config.provider === "deepseek") {
      const failure = deepseekEventFailure(event, probe);
      if (failure) return failure;
      if (event.type === "tool_call") {
        metrics.firstToolMs ??= elapsedMs;
        tools.add(event.callId);
        metrics.toolCount = tools.size;
        report(`tool started: ${event.tool}`);
      } else if (event.type === "tool_result")
        report(`tool ${event.status}: ${event.callId}`);
      else if (event.type === "session" || event.type === "final")
        report(`dsh ${event.type}: ${event.sessionId}`);
      if (event.type === "status" && event.phase === "step_end") {
        deepseekSteps++;
        if (!event.usage || typeof event.usage !== "object") {
          incompleteUsage = true;
          delete metrics.usage;
        } else if (!incompleteUsage) {
          const usage = Object.fromEntries(
            Object.entries(event.usage).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number" && Number.isFinite(entry[1]),
            ),
          );
          if (deepseekSteps === 1) metrics.usage = usage;
          else
            for (const key of Object.keys(metrics.usage ?? {})) {
              if (usage[key] === undefined) delete metrics.usage![key];
              else metrics.usage![key] = metrics.usage![key]! + usage[key]!;
            }
        }
      }
      return;
    }
    if (["command_execution", "mcp_tool_call"].includes(item?.type)) {
      metrics.firstToolMs ??= elapsedMs;
      tools.add(item.id ?? `${item.type}:${item.command ?? item.tool}`);
      metrics.toolCount = tools.size;
    }
    if (event?.usage && typeof event.usage === "object")
      metrics.usage = Object.fromEntries(
        Object.entries(event.usage).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      );
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
    metrics(): ProviderMetrics {
      return { ...metrics, durationMs: performance.now() - started };
    },
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
      const stdout = pending.stdout;
      const stderr = pending.stderr;
      pending.stdout = "";
      pending.stderr = "";
      return line("stdout", stdout) ?? line("stderr", stderr);
    },
  };
}
