import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isKnownBranch, readBranches, readChanges, readFileAtBranch, readFileAtTree, snapshotWorkspace } from "../packages/server/src/git";

const git = (folder: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: folder, stdio: "pipe" }).toString();

const directory = mkdtempSync(join(tmpdir(), "branchboard-git-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const repositoryWith = (name: string, content: string) => {
  const folder = mkdtempSync(join(directory, "repo-"));
  git(folder, "init", "-q", "-b", "main");
  writeFileSync(join(folder, name), content);
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "first");
  return folder;
};

describe("git helpers", () => {
  it("lists branches, reads a file from another branch and diffs against it", async () => {
    const folder = repositoryWith("app.ts", "one\ntwo\nthree\n");
    const file = join(folder, "app.ts");
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

  it("snapshots the working tree without touching the index or refs", async () => {
    const folder = repositoryWith("a.txt", "one\n");
    writeFileSync(join(folder, "a.txt"), "changed\n");
    writeFileSync(join(folder, "untracked.txt"), "new\n");
    const statusBefore = git(folder, "status", "--porcelain");
    const headBefore = git(folder, "rev-parse", "HEAD");
    const tree = await snapshotWorkspace(folder);
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
    expect(git(folder, "status", "--porcelain")).toBe(statusBefore);
    expect(git(folder, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await readFileAtTree(folder, tree!, "a.txt")).toEqual({ kind: "text", text: "changed\n" });
    expect(await readFileAtTree(folder, tree!, "untracked.txt")).toEqual({ kind: "text", text: "new\n" });
    expect(await readFileAtTree(folder, tree!, "missing.txt")).toEqual({ kind: "absent" });
    expect(await readFileAtTree(folder, "f".repeat(40), "a.txt")).toEqual({ kind: "unavailable" });
  });

  it("reports a plain folder as not a repository and takes no snapshot of it", async () => {
    const plain = mkdtempSync(join(directory, "plain-"));
    writeFileSync(join(plain, "a.txt"), "x");
    expect(await readBranches(plain)).toEqual({ isRepo: false, branches: [] });
    expect(await snapshotWorkspace(plain)).toBeUndefined();
  });
});
