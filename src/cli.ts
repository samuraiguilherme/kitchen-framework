import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Kitchen } from "./kitchen.ts";
import { doctor } from "./doctor.ts";
import { evaluate } from "./evaluate.ts";
import { execute } from "./process.ts";
import { stationOrder } from "./domain.ts";
import type { Station } from "./types.ts";

const usage = `Local Development Kitchen
  pnpm kitchen doctor
  pnpm kitchen start <feature> --request-file <path> [--issue <url>]
  pnpm kitchen run <feature> <station> [--feedback-file <path>] [--observations <json>]
  pnpm kitchen approve <feature> <station> --actor <name> [--resolutions <json>] [--minutes <n>]
  pnpm kitchen status <feature>
  pnpm kitchen report <feature> [--output <path>]
  pnpm kitchen evaluate <station> [--labels <json>] [--live]
  pnpm kitchen publish <feature> --preview
  pnpm kitchen publish <feature>
Stations: ${stationOrder.join(", ")}
Every run pauses for review. Publication requires its own preview and approval.`;
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      preview: { type: "boolean" },
      live: { type: "boolean" },
      "request-file": { type: "string" },
      request: { type: "string" },
      issue: { type: "string" },
      actor: { type: "string" },
      "feedback-file": { type: "string" },
      feedback: { type: "string" },
      resolutions: { type: "string" },
      observations: { type: "string" },
      output: { type: "string" },
      labels: { type: "string" },
      minutes: { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(usage);
    return;
  }
  const cwd = process.cwd();
  const top = await execute("git", ["rev-parse", "--show-toplevel"], cwd);
  const common = path.resolve(
    top,
    await execute("git", ["rev-parse", "--git-common-dir"], top),
  );
  const root = path.dirname(common);
  const kitchen = new Kitchen({ root });
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    console.error(
      "Cancelling owned subprocesses; state will remain recoverable.",
    );
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const terminal = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const ask = terminal
    ? (question: string) =>
        terminal.question(question + "\n> ", { signal: controller.signal })
    : undefined;
  const readJson = (file?: string) =>
    file
      ? JSON.parse(readFileSync(path.resolve(cwd, file), "utf8"))
      : undefined;
  const station = (value?: string): Station => {
    if (!stationOrder.includes(value as Station))
      throw new Error("Select a valid station: " + stationOrder.join(", "));
    return value as Station;
  };
  try {
    const [command, feature, selected] = positionals;
    if (command === "doctor") {
      const results = await doctor(root);
      console.log(JSON.stringify(results, null, 2));
      if (results.some((r) => r.required && r.status !== "passed"))
        process.exitCode = 1;
      return;
    }
    if (command === "evaluate") {
      console.log(
        JSON.stringify(
          await evaluate(root, station(feature), {
            labels: values.labels
              ? path.resolve(cwd, values.labels)
              : undefined,
            live: values.live,
            signal: controller.signal,
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (!feature) throw new Error("Feature name required.");
    if (command === "start") {
      const request = values["request-file"]
        ? readFileSync(path.resolve(cwd, values["request-file"]), "utf8")
        : (values.request ??
          (ask
            ? await ask("What problem and outcome should this feature address?")
            : ""));
      console.log(
        JSON.stringify(
          await kitchen.start(feature, { request, issue: values.issue }),
          null,
          2,
        ),
      );
    } else if (command === "run") {
      const feedback = values["feedback-file"]
        ? readFileSync(path.resolve(cwd, values["feedback-file"]), "utf8")
        : values.feedback;
      const observations = readJson(values.observations);
      if (
        observations &&
        (!Array.isArray(observations) ||
          observations.some(
            (o) =>
              !o.id ||
              typeof o.observation !== "string" ||
              !Array.isArray(o.evidence) ||
              !["passed", "failed", "not-applicable"].includes(o.status),
          ))
      )
        throw new Error("Invalid human observations JSON.");
      console.log(
        JSON.stringify(
          await kitchen.run(feature, station(selected), {
            ask,
            feedback,
            signal: controller.signal,
            observations,
          }),
          null,
          2,
        ),
      );
    } else if (command === "approve") {
      const actor =
        values.actor ??
        (ask ? await ask("Your name for this acceptance record?") : "");
      const resolutions = readJson(values.resolutions);
      if (
        resolutions &&
        (typeof resolutions !== "object" ||
          Array.isArray(resolutions) ||
          Object.values(resolutions).some(
            (r) => typeof r !== "string" || !r.trim(),
          ))
      )
        throw new Error(
          "Resolutions must map finding IDs to your reason for disputing them.",
        );
      const reviewMinutes =
        values.minutes === undefined ? undefined : Number(values.minutes);
      if (
        reviewMinutes !== undefined &&
        (!Number.isFinite(reviewMinutes) || reviewMinutes < 0)
      )
        throw new Error("Review minutes must be a nonnegative number.");
      console.log(
        JSON.stringify(
          await kitchen.approve(feature, station(selected), {
            actor,
            resolutions,
            reviewMinutes,
          }),
          null,
          2,
        ),
      );
    } else if (command === "status")
      console.log(JSON.stringify(await kitchen.status(feature), null, 2));
    else if (command === "report") {
      const report = await kitchen.report(feature);
      if (values.output) {
        const target = path.resolve(cwd, values.output);
        writeFileSync(target, report);
        console.log(target);
      } else console.log(report);
    } else if (command === "publish")
      console.log(
        JSON.stringify(
          await kitchen.publish(feature, { preview: values.preview }),
          null,
          2,
        ),
      );
    else throw new Error("Unknown command.\n" + usage);
  } finally {
    terminal?.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
