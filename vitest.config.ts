import { defineConfig } from "vitest/config";
import { coreTests } from "./test-lanes.ts";

const lane = process.env.KITCHEN_TEST_LANE ?? "all";
if (!["all", "core", "integration"].includes(lane))
  throw new Error("KITCHEN_TEST_LANE must be all, core or integration.");

export default defineConfig({
  test: {
    environment: "node",
    include: lane === "core" ? coreTests : ["test/**/*.test.ts"],
    exclude: lane === "integration" ? coreTests : [],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Separate workers retain Vitest's default isolation. Never run shared
    // mocks or stateful tests concurrently inside a file.
    fileParallelism: true,
    minWorkers: 1,
    maxWorkers: 2,
  },
});
