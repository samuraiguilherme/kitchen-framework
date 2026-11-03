import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { digest, hash, safePath } from "../src/domain.ts";
import { sourceFiles } from "../src/git.ts";

const { values } = parseArgs({
  options: {
    files: { type: "string", default: "500" },
    iterations: { type: "string", default: "3" },
  },
});
const count = Number(values.files);
const iterations = Number(values.iterations);
if (
  !Number.isSafeInteger(count) ||
  count < 1 ||
  !Number.isSafeInteger(iterations) ||
  iterations < 1
)
  throw new Error("--files and --iterations must be positive integers.");

const root = fileURLToPath(new URL("../", import.meta.url));
const files = (await sourceFiles(root, "hashing-benchmark")).slice(0, count);
// Preserve the original implementation as a comparison, including all original
// safety checks. No provider requests, source writes or dependency setup run.
const legacy = () =>
  hash(
    JSON.stringify(
      [...new Set(files)].sort().map((file) => [
        file,
        existsSync(safePath(root, file))
          ? hash(readFileSync(safePath(root, file)))
          : null,
      ]),
    ),
  );
for (let run = 1; run <= iterations; run++) {
  const started = performance.now();
  const expected = legacy();
  const legacyMs = performance.now() - started;
  const optimizedStarted = performance.now();
  const actual = digest(root, files);
  const optimizedMs = performance.now() - optimizedStarted;
  if (expected !== actual) throw new Error("Source digest changed.");
  console.log(
    JSON.stringify({
      run,
      files: files.length,
      legacyMs: Math.round(legacyMs),
      optimizedMs: Math.round(optimizedMs),
      speedup: Number((legacyMs / optimizedMs).toFixed(2)),
      identical: true,
    }),
  );
}
