import type { AuthorOutput } from "./types.ts";

export function normalizeTestPlan(output: AuthorOutput): AuthorOutput {
  const ids = new Map(
    output.checks.map(({ id }) => [
      id,
      id
        .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    ]),
  );
  const changed = [...ids.keys()]
    .filter((id) => id && ids.get(id) !== id)
    .sort((a, b) => b.length - a.length);
  let document = output.document;
  if (document && changed.length) {
    const alternatives = changed
      .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    // Replace complete check references, preserving paths and longer IDs.
    document = document.replace(
      new RegExp(
        `(?<![A-Za-z0-9_./\\\\-])(?:${alternatives})(?![A-Za-z0-9_/\\\\-]|\\.[A-Za-z0-9])`,
        "g",
      ),
      (id) => ids.get(id)!,
    );
  }
  return {
    ...output,
    document,
    checks: output.checks.map((check) => ({
      ...check,
      id: ids.get(check.id)!,
    })),
  };
}
