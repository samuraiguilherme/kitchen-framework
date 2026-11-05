import { expect, it } from "vitest";
import { checkCapabilities } from "../scripts/lib/test-environment.ts";

it("reports independent infrastructure failures without treating them as passed or hiding later probes", async () => {
  const calls: string[] = [];
  const result = await checkCapabilities({
    loopback: () => { calls.push("loopback"); throw new Error("fetch failed"); },
    symlink: () => { calls.push("symlink"); throw new Error("EPERM"); },
    git: () => { calls.push("git"); },
  });
  expect(calls).toEqual(["loopback", "symlink", "git"]);
  expect(result).toEqual([
    { id: "loopback", passed: false, reason: "fetch failed" },
    { id: "symlink", passed: false, reason: "EPERM" },
    { id: "git", passed: true },
  ]);
});
