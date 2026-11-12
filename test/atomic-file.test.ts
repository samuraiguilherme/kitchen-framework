import { renameSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { replaceFileSync } from "../src/atomic-file.ts";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  renameSync: vi.fn(),
}));

afterEach(() => {
  vi.mocked(renameSync).mockReset();
  vi.restoreAllMocks();
});

it.runIf(process.platform === "win32")("retries the same atomic rename when Windows temporarily locks the destination", () => {
  const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw Object.assign(new Error("Locked destination"), { code: "EPERM" });
  });
  replaceFileSync("state.tmp", "state.json");
  expect(vi.mocked(renameSync).mock.calls).toEqual([["state.tmp", "state.json"], ["state.tmp", "state.json"]]);
  expect(wait).toHaveBeenCalledTimes(1);
});

it("surfaces permanent rename errors immediately", () => {
  const error = Object.assign(new Error("Missing temporary file"), { code: "ENOENT" });
  vi.mocked(renameSync).mockImplementation(() => { throw error; });
  expect(() => replaceFileSync("state.tmp", "state.json")).toThrow(error);
  expect(renameSync).toHaveBeenCalledTimes(1);
});
