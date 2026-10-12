import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateFeature,
  safePath,
  digest,
  lintDocument,
  acceptanceIds,
  gateReady,
  stationOrder,
} from "../src/domain.ts";

describe("feature and file boundaries", () => {
  it.each(["candidate-invitations", "1625-crm-companies"])(
    "accepts %s",
    (feature) => {
      expect(validateFeature(feature)).toBe(feature);
    },
  );
  it.each([
    "../escape",
    "a/b",
    "a\\b",
    "UPPER",
    "",
    "con",
    "nul",
    "a".repeat(65),
  ])("rejects %s", (feature) => {
    expect(() => validateFeature(feature)).toThrow();
  });
  it.each([
    "../outside",
    "/outside",
    "C:\\outside",
    ".git/config",
    ".kitchen/state.json",
    ".env",
    "src/../../outside",
    "node_modules/a",
    ".claude/settings.json",
  ])("rejects unsafe output %s", (file) => {
    expect(() => safePath(process.cwd(), file)).toThrow();
  });
  it("allows planned source and tests", () => {
    expect(safePath(process.cwd(), "src/domain.test.ts")).toBe(
      path.resolve("src/domain.test.ts"),
    );
  });
  it("rejects a parent symlink leading outside the worktree", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-path-"));
    const outside = mkdtempSync(path.join(tmpdir(), "kitchen-outside-"));
    mkdirSync(path.join(root, "src"));
    symlinkSync(outside, path.join(root, "src/link"), "junction");
    expect(() => safePath(root, "src/link/file.ts")).toThrow();
  });
  it("hashes contents deterministically and includes deletions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kitchen-digest-"));
    writeFileSync(path.join(root, "a"), "one");
    expect(digest(root, ["a", "missing"])).toBe(digest(root, ["missing", "a"]));
    const before = digest(root, ["a"]);
    writeFileSync(path.join(root, "a"), "two");
    expect(digest(root, ["a"])).not.toBe(before);
    expect(digest(root, ["a", "missing"])).not.toBe(digest(root, ["a"]));
  });
});

describe("station contracts", () => {
  it("puts unit tests before production implementation", () => {
    expect(stationOrder.indexOf("unit-tests")).toBeLessThan(
      stationOrder.indexOf("implementation"),
    );
  });
  it("extracts definitions without counting references as duplicate criteria", () => {
    expect(
      acceptanceIds(
        "| AC-1 | Invite | Sends once |\nSee AC-1\n| AC-2 | Deny | Unchanged |\n",
      ),
    ).toEqual(["AC-1", "AC-2"]);
  });
  it("rejects contradictory duplicate acceptance IDs", () => {
    expect(() => acceptanceIds("| AC-1 | A | B |\n| AC-1 | C | D |\n")).toThrow(
      /duplicate/i,
    );
  });
  it("flags an incomplete intent and unresolved placeholders", () => {
    expect(
      lintDocument("intent", "# <Title>\n## Who is affected\nEveryone").length,
    ).toBeGreaterThan(0);
  });
  it.each(["Regression", "Required evidence"])(
    "requires an exact, nonempty %s test-plan section",
    (heading) => {
      const document =
        "# Test plan\n## Acceptance coverage\nAC-1: unit.\n" +
        "## Unit tests\nsrc/answer.test.ts\n## Regression\nExisting suite GREEN.\n" +
        "## Required evidence\nBehavioral RED and final GREEN reports.\n";
      expect(lintDocument("test-plan", document)).toEqual([]);
      expect(
        lintDocument(
          "test-plan",
          document.replace(`## ${heading}\n`, `## ${heading} and blockers\n`),
        ),
      ).toContainEqual(
        expect.objectContaining({ rule: "missing-section", evidence: heading }),
      );
      expect(
        lintDocument(
          "test-plan",
          document.replace(
            new RegExp(`(## ${heading}\\n)[^]*?(?=\\n## |$)`),
            "$1<!-- fill this section -->\n",
          ),
        ),
      ).toContainEqual(
        expect.objectContaining({ rule: "empty-section", evidence: heading }),
      );
    },
  );
  it("flags a specification without observable acceptance criteria", () => {
    expect(
      lintDocument(
        "spec",
        "# Invites\n## Summary\nMake it good\n## Requirements and acceptance criteria\nFast\n## Roles and permissions\nOwner\n## Business rules and edge cases\nNone\n",
      ),
    ).toContainEqual(
      expect.objectContaining({ rule: "acceptance-criteria", blocking: true }),
    );
  });
  it("does not turn an unresolved reviewer blocker into approval", () => {
    expect(
      gateReady(
        [
          {
            id: "x",
            rule: "permissions",
            blocking: true,
            evidence: "spec lacks tenant boundary",
            consequence: "cross-tenant write",
            resolution: "define tenant scope",
          },
        ],
        [],
        {},
      ),
    ).toBe(false);
    expect(
      gateReady(
        [
          {
            id: "x",
            rule: "permissions",
            blocking: true,
            evidence: "spec lacks tenant boundary",
            consequence: "cross-tenant write",
            resolution: "define tenant scope",
          },
        ],
        [],
        { x: "Existing explicit company-boundary rule covers this finding." },
      ),
    ).toBe(true);
  });
  it.each(["failed", "unverified"])("blocks a required %s check", (status) => {
    expect(gateReady([], [{ id: "unit", required: true, status }], {})).toBe(
      false,
    );
  });
  it("permits explicit optional gaps without disguising them as passes", () => {
    expect(
      gateReady(
        [],
        [{ id: "live", required: false, status: "unverified" }],
        {},
      ),
    ).toBe(true);
  });
});
