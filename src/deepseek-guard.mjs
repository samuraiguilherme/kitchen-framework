// This module runs inside DSH. The runner must depend on kitchenReadOnly so
// a missing or incompatible guard fails startup before any model task.
export const name = "kitchen-read-only";
export const inject = ["tools"];

export function apply(ctx, config) {
  if (
    typeof ctx.tools?.guard !== "function" ||
    typeof ctx.provide !== "function"
  )
    throw new Error("DSH does not support Kitchen's required tool guard.");
  const allowed = new Set(config.allowTools);
  if ([...allowed].some((tool) => !["read", "glob", "grep"].includes(tool)))
    throw new Error("Invalid Kitchen tool allowlist.");
  ctx.tools.guard((call) =>
    allowed.has(call.name) ? undefined : `KITCHEN_TOOL_DENIED: ${call.name}`,
  );
  ctx.provide("kitchenReadOnly", Object.freeze({}));
}
