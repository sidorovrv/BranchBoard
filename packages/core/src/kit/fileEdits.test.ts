import { describe, expect, it } from "vitest";
import { collapseUnchanged, contentBeforeSteps, diffLineCounts, diffRows, editStepsByPath, fileDisplayNames, fileEditOf, fileEditsOf, gitChangesOf, patchTextOfFileChanges, rowsOfGitChanges, totalChange, type FileChange } from "./fileEdits";
import type { ChatPart } from "./types";

const toolPart = (id: string, tool: string, input: unknown, status = "done"): ChatPart => ({ id, seq: 0, type: "tool", text: "", meta: { tool, input, status } });

describe("file edit counters", () => {
  it("counts changed lines like a line diff", () => {
    expect(diffLineCounts("a\nb\nc", "a\nB\nc\nd")).toEqual({ added: 2, removed: 1 });
    expect(diffLineCounts("", "x\ny\n")).toEqual({ added: 2, removed: 0 });
    expect(diffLineCounts("same", "same")).toEqual({ added: 0, removed: 0 });
  });

  it("reads Claude and OpenCode edit tool inputs", () => {
    expect(fileEditOf("Edit", { file_path: "a.ts", old_string: "x", new_string: "y\nz" })).toMatchObject({ path: "a.ts", added: 2, removed: 1 });
    expect(fileEditOf("edit", { filePath: "b.ts", oldString: "x", newString: "x" })).toMatchObject({ path: "b.ts", added: 0, removed: 0 });
    expect(fileEditOf("Write", { file_path: "c.ts", content: "1\n2\n3\n" })).toMatchObject({ path: "c.ts", added: 3, removed: 0 });
    expect(fileEditOf("MultiEdit", { file_path: "d.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "", new_string: "c" }] })).toMatchObject({ path: "d.ts", added: 2, removed: 1 });
    expect(fileEditOf("Bash", { command: "ls" })).toBeUndefined();
  });

  it("sums edits per file and skips failed tools", () => {
    const edits = fileEditsOf([
      toolPart("1", "Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }),
      toolPart("2", "Edit", { file_path: "a.ts", old_string: "p", new_string: "q\nr" }),
      toolPart("3", "Write", { file_path: "b.ts", content: "z" }),
      toolPart("4", "Edit", { file_path: "c.ts", old_string: "p", new_string: "q" }, "error"),
    ]);
    expect(edits).toMatchObject([
      { path: "a.ts", added: 3, removed: 2 },
      { path: "b.ts", added: 1, removed: 0 },
    ]);
    expect(edits[0]?.rows.filter((row) => row.kind === "gap")).toHaveLength(1);
    expect(totalChange(edits)).toEqual({ added: 4, removed: 2 });
  });

  it("builds diff rows with context", () => {
    expect(diffRows("a\nb\nc\nd", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "same", text: "d" },
    ]);
    expect(diffRows("", "x")).toEqual([{ kind: "add", text: "x" }]);
  });

  it("diffs the whole file when the context is unlimited", () => {
    const before = "a\nb\nc\nd\ne\nf\ng";
    const after = "a\nb\nc\nD\ne\nf\ng";
    expect(diffRows(before, after, Infinity).filter((row) => row.kind === "same")).toHaveLength(6);
    expect(diffRows(before, after).filter((row) => row.kind === "same")).toHaveLength(4);
  });

  it("turns diff rows into added lines and removed blocks and back", () => {
    const before = "one\ntwo\nthree\nfour\n";
    const after = "zero\none\nthree\nfour\nfive\n";
    const changes = gitChangesOf(diffRows(before, after, Infinity));
    expect(changes).toEqual({ added: [1, 5], removed: 1, removedBlocks: [{ after: 2, lines: ["two"] }] });
    const rows = rowsOfGitChanges(after, changes);
    expect(rows.map((row) => `${row.kind}:${row.text}`)).toEqual(["add:zero", "same:one", "remove:two", "same:three", "same:four", "add:five"]);
    expect(gitChangesOf(rows)).toEqual(changes);
  });

  it("collapses unchanged rows far from any change", () => {
    const rows = diffRows("1\n2\n3\n4\n5\n6\n7\n8\n9", "1\n2\n3\n4\n5\n6\n7\n8\nnine", Infinity);
    const collapsed = collapseUnchanged(rows, 2);
    expect(collapsed.map((row) => row.kind)).toEqual(["gap", "same", "same", "remove", "add"]);
  });

  it("shows the parent folder only when file names collide", () => {
    expect(fileDisplayNames(["src/a.ts", "lib/a.ts", "b.ts"])).toEqual(["src/a.ts", "lib/a.ts", "b.ts"]);
  });
});

describe("patch tool", () => {
  const patchText = ["*** Begin Patch", "*** Add File: c.txt", "+one", "+two", "*** Update File: a.txt", "@@", " keep", "-old", "+new", "*** Delete File: gone.txt", "*** End Patch"].join("\n");

  it("lists every file section with its line counts", () => {
    const edits = fileEditsOf([toolPart("p", "patch", { patchText })]);
    expect(edits.map((edit) => [edit.path, edit.added, edit.removed])).toEqual([["c.txt", 2, 0], ["a.txt", 1, 1], ["gone.txt", 0, 0]]);
  });

  it("tracks file steps and undoes only creations", () => {
    const steps = editStepsByPath([toolPart("p", "patch", { patchText })]);
    expect([...steps.keys()]).toEqual(["c.txt", "a.txt", "gone.txt"]);
    expect(contentBeforeSteps(steps.get("c.txt")!, "one\ntwo")).toBeNull();
    expect(contentBeforeSteps(steps.get("a.txt")!, "keep\nnew")).toBeUndefined();
  });

  it("ignores failed patches", () => {
    expect(fileEditsOf([toolPart("p", "patch", { patchText }, "error")])).toEqual([]);
  });
});

describe("patch text of per-file diffs", () => {
  const changes: FileChange[] = [
    { path: "new.txt", action: "add", diff: "hello\nworld\n" },
    { path: "a.txt", action: "update", diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n" },
    { path: "gone.txt", action: "delete", diff: "bye\n" },
    { path: "e.txt", action: "update", movePath: "f.txt", diff: "@@ -1 +1 @@\n-e\n+E\n\n\nMoved to: f.txt" },
  ];
  const patchText = patchTextOfFileChanges(changes);

  it("writes one section per change in the patch format", () => {
    expect(patchText.split("\n")).toEqual([
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+hello",
      "+world",
      "*** Update File: a.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
      "*** Delete File: gone.txt",
      "*** Update File: e.txt",
      "*** Move to: f.txt",
      "@@ -1 +1 @@",
      "-e",
      "+E",
      "*** End Patch",
    ]);
  });

  it("feeds the edit summary and the revert steps", () => {
    const parts = [toolPart("p", "patch", { patchText })];
    expect(fileEditsOf(parts).map((edit) => [edit.path, edit.added, edit.removed])).toEqual([["new.txt", 2, 0], ["a.txt", 1, 1], ["gone.txt", 0, 0], ["f.txt", 1, 1]]);
    const steps = editStepsByPath(parts);
    expect(contentBeforeSteps(steps.get("new.txt")!, "hello\nworld")).toBeNull();
    expect(contentBeforeSteps(steps.get("a.txt")!, "one\nTWO")).toBeUndefined();
  });
});
