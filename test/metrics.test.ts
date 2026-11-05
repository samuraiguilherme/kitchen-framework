import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promptSections, runMetrics, timed } from "../src/metrics.ts";
import { providerProgress } from "../src/provider-progress.ts";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "kitchen-metrics-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("runner timing evidence", () => {
it("starts independent runs with a wall-clock timestamp and no inferred provider or human time", () => {
    const first = runMetrics();
    const second = runMetrics();
    expect(Number.isFinite(Date.parse(first.startedAt))).toBe(true);
    expect(first.humanWaitMs).toBe(0);
    expect(first.providers).toEqual([]);
    expect(first.promptBytes).toEqual([]);
    expect(first.completedAt).toBeUndefined();
    first.phases.push({ phase: "one run only", durationMs: 1 });
    expect(second.phases).toEqual([]);
  });
it("records elapsed phases for successful and failed operations without swallowing results or errors", async () => {
    const metrics = runMetrics();
    const progress: string[] = [];
    expect(
      await timed(
        metrics,
        "context",
        async () => "ready",
        (message) => progress.push(message),
      ),
    ).toBe("ready");
    await expect(
      timed(metrics, "provider", async () => {
        throw new Error("Unavailable");
      }),
    ).rejects.toThrow("Unavailable");
    expect(metrics.phases.map(({ phase }) => phase)).toEqual([
      "context",
      "provider",
    ]);
    expect(
      metrics.phases.every(
        ({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0,
      ),
    ).toBe(true);
    expect(progress).toEqual(["Preparing context…"]);
  });
it("accounts for every UTF-8 prompt byte across authoritative documents, conversation, context and diff", () => {
    const prompt =
      "Introduction caf\u00e9\nHuman/model conversation (roles are significant):\n[]\nRubric:\nRules\nStation boundaries:\nRead only\nExisting template:\nTemplate\nContext:\nContext prefix\nDOCUMENT docs/features/sort/intent.md\nIntent \u00e9vidence\nCHECK PROFILES:\n{}\nLOCAL RUN STATE:\n{}\nRUNNER PREPARATION:\nnull\nDISCOVERY:\n[]\nDIFF:\nsource diff\nUNTRACKED FILES:\nnew.ts\nHuman revision request:\nUse ascending order.\n";
    const sections = promptSections(prompt);
    expect(
      Object.values(sections).reduce((total, bytes) => total + bytes, 0),
    ).toBe(Buffer.byteLength(prompt));
    expect(sections.instructions).toBe(
      Buffer.byteLength("Introduction caf\u00e9\n"),
    );
    expect(sections["DOCUMENT docs/features/sort/intent.md"]).toBe(
      Buffer.byteLength(
        "DOCUMENT docs/features/sort/intent.md\nIntent \u00e9vidence\n",
      ),
    );
    for (const name of [
      "Human/model conversation",
      "Rubric",
      "Station boundaries",
      "Existing template",
      "Context",
      "CHECK PROFILES",
      "LOCAL RUN STATE",
      "RUNNER PREPARATION",
      "DISCOVERY",
      "DIFF",
      "UNTRACKED FILES",
      "Human revision request",
    ])
      expect(sections[name]).toBeGreaterThan(0);
  });
it("timestamps parsed events while preserving raw output and counting each tool only once", () => {
    const root = fixture();
    mkdirSync(path.join(root, "run"));
    const progress = providerProgress({
      station: "plan",
      role: "author",
      cwd: root,
      runDir: path.join(root, "run"),
      config: { provider: "codex" },
      prompt: "discover",
      timeoutMs: 1000,
    });
    const events = [
      { type: "thread.started" },
      {
        type: "item.started",
        item: {
          id: "tool-1",
          type: "command_execution",
          command: "read source",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "tool-1",
          type: "command_execution",
          command: "read source",
          status: "completed",
          exit_code: 0,
        },
      },
      {
        type: "item.started",
        item: {
          id: "tool-2",
          type: "mcp_tool_call",
          server: "fixture",
          tool: "read",
        },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 4, output_tokens: 2, non_numeric: "excluded" },
      },
    ];
    const raw = events.map((event) => JSON.stringify(event)).join("\n");
    progress.capture("stdout", raw.slice(0, 15));
    progress.capture("stdout", raw.slice(15));
    progress.finish();
    const metrics = progress.metrics();
    expect(metrics.toolCount).toBe(2);
    expect(metrics.firstEventMs).toBeGreaterThanOrEqual(0);
    expect(metrics.firstToolMs).toBeGreaterThanOrEqual(metrics.firstEventMs!);
    expect(metrics.durationMs).toBeGreaterThanOrEqual(metrics.firstToolMs!);
    expect(metrics.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
    expect(
      readFileSync(path.join(root, "run/author-events.jsonl"), "utf8"),
    ).toBe(raw);
    const timings = readFileSync(
      path.join(root, "run/author-timing-events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(timings).toHaveLength(events.length);
    expect(
      timings.every(
        (event, index) =>
          event.elapsedMs >= 0 && event.type === events[index]!.type,
      ),
    ).toBe(true);
    expect(timings[1]).toMatchObject({
      itemType: "command_execution",
      itemId: "tool-1",
    });
  });
});
