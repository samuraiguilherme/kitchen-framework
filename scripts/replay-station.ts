import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { captureReplay, replayStation, verifyReplayBundle } from "../src/replay.ts";

const { values } = parseArgs({ options: {
  capture: { type: "string" }, project: { type: "string" }, bundle: { type: "string" },
  output: { type: "string" }, role: { type: "string" },
  mode: { type: "string", default: "saved" }, live: { type: "boolean", default: false }, config: { type: "string" },
} });
if (!values.output || (!!values.capture === !!values.bundle))
  throw new Error("Use --capture <saved-role-directory> --project <main-checkout> --output <new-bundle>, or --bundle <capture> --output <new-result> [--live] [--mode saved|current] [--config <file>].");
if (values.role && !["author", "review"].includes(values.role)) throw new Error("Role must be author or review.");
if (values.capture) {
  if (!values.project || values.live || values.config || values.mode !== "saved") throw new Error("Capture requires --project and never calls a model. Select replay settings when using --bundle.");
  await captureReplay({ evidence: values.capture, project: values.project, output: values.output, role: (values.role ?? "author") as "author" | "review" });
  console.log(`Frozen replay bundle: ${values.output}`);
} else {
  if (values.project) throw new Error("Replay uses the captured source; --project is only for capture.");
  const override = values.config ? JSON.parse(readFileSync(values.config, "utf8")) : undefined;
  const role = verifyReplayBundle(values.bundle!).role;
  if (values.role && values.role !== role) throw new Error("Replay role must match the captured role.");
  if (override && !override.providers?.[role]) throw new Error("Override must specify the captured providers role.");
  const result = await replayStation({ bundle: values.bundle!, output: values.output, live: values.live,
    mode: values.mode as "saved" | "current", config: override?.providers?.[role] });
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}
