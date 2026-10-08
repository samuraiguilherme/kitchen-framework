import { describe, expect, it } from "vitest";
import { GitHub } from "../src/github.ts";

describe("GitHub boundary", () => {
  it("uses explicit head/base/repository and a body file for draft PRs", async () => {
    const calls: string[][] = [];
    const github = new GitHub(async (_command, args) => { calls.push(args); return "https://github.com/HireBus/hirebus-v3/pull/1\n"; });
    const url = await github.create({ repository: "HireBus/hirebus-v3", base: "develop", head: "codex/kitchen/invites", title: "Invites", bodyFile: "C:\\a space\\pr.md" });
    expect(url).toContain("/pull/1");
    expect(calls[0]).toEqual(expect.arrayContaining(["--repo", "HireBus/hirebus-v3", "--base", "develop", "--head", "codex/kitchen/invites", "--body-file", "C:\\a space\\pr.md", "--draft"]));
  });
  it("looks up an existing PR without pushing or creating", async () => {
    const calls: string[][] = [];
    const github = new GitHub(async (_command, args) => { calls.push(args); return JSON.stringify([{ url: "https://github.com/HireBus/hirebus-v3/pull/1" }]); });
    expect(await github.find("HireBus/hirebus-v3", "codex/kitchen/invites")).toContain("/pull/1");
    expect(calls[0]?.slice(0, 2)).toEqual(["pr", "list"]);
  });
});
