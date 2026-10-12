import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isKnownBranch, readBranches, readChanges, readFileAtBranch } from "../packages/server/src/git";

const git = (folder: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: folder, stdio: "pipe" });

describe("git helpers", () => {
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
      expect(await readChanges(folder, file, "main", "feature", "one\nTWO\nthree\nfour\n")).toEqual({ added: [2, 4], removed: 1, removedBlocks: [{ after: 1, lines: ["two"] }] });
      writeFileSync(file, "one\ntwo\nthree\nlocal\n");
      expect(await readChanges(folder, file, "main", undefined, "one\ntwo\nthree\nlocal\n")).toEqual({ added: [4], removed: 0, removedBlocks: [] });
      expect(await readChanges(folder, file, "main", undefined, "one\nthree\nlocal\n")).toEqual({ added: [3], removed: 1, removedBlocks: [{ after: 1, lines: ["two"] }] });
      expect(await readChanges(folder, join(folder, "untracked.ts"), "main", undefined, "x")).toEqual({ added: [], removed: 0, removedBlocks: [] });
    });

    it("reports a plain folder as not a repository", async () => {
      const plain = mkdtempSync(join(tmpdir(), "branchboard-plain-"));
      expect(await readBranches(plain)).toEqual({ isRepo: false, branches: [] });
      rmSync(plain, { recursive: true, force: true });
    });
  });
});
