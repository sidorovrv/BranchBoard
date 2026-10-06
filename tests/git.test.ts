import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changedLinesOf, isKnownBranch, readBranches, readChanges, readFileAtBranch } from "../packages/server/src/git";

const git = (folder: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: folder, stdio: "pipe" });

describe("git helpers", () => {
  it("collects added line numbers and removed counts from a zero-context diff", () => {
    const diff = ["diff --git a/a.ts b/a.ts", "@@ -2,2 +2,3 @@", "-old", "-older", "+new", "+newer", "+newest", "@@ -10 +11,0 @@", "-gone", "@@ -20,0 +21 @@", "+added"].join("\n");
    expect(changedLinesOf(diff)).toEqual({ added: [2, 3, 4, 21], removed: 3, removedAfter: [1, 11] });
  });

  describe("in a repository", () => {
    const folder = mkdtempSync(join(tmpdir(), "branchboard-git-"));
    const file = join(folder, "app.ts");
    afterAll(() => rmSync(folder, { recursive: true, force: true }));

    it("lists branches, reads a file from another branch and diffs against it", async () => {
      git(folder, "init", "-q", "-b", "main");
      writeFileSync(file, "one\ntwo\nthree\n");
      git(folder, "add", ".");
      git(folder, "commit", "-q", "-m", "first");
      git(folder, "checkout", "-q", "-b", "feature");
      writeFileSync(file, "one\nTWO\nthree\nfour\n");
      git(folder, "commit", "-q", "-am", "feature work");
      git(folder, "checkout", "-q", "main");
      expect(await readBranches(folder)).toEqual({ isRepo: true, current: "main", branches: expect.arrayContaining(["main", "feature"]) });
      expect(await isKnownBranch(folder, "feature")).toBe(true);
      expect(await isKnownBranch(folder, "--output=x")).toBe(false);
      expect(await readFileAtBranch(folder, file, "feature")).toBe("one\nTWO\nthree\nfour\n");
      expect(await readChanges(folder, file, "main", "feature")).toEqual({ added: [2, 4], removed: 1, removedAfter: [1] });
      writeFileSync(file, "one\ntwo\nthree\nlocal\n");
      expect(await readChanges(folder, file, "main", undefined)).toEqual({ added: [4], removed: 0, removedAfter: [] });
    });

    it("reports a plain folder as not a repository", async () => {
      const plain = mkdtempSync(join(tmpdir(), "branchboard-plain-"));
      expect(await readBranches(plain)).toEqual({ isRepo: false, branches: [] });
      rmSync(plain, { recursive: true, force: true });
    });
  });
});
