import { describe, expect, it } from "vitest";
import { diffLineCounts, diffRows,fileDisplayNames, fileEditOf, fileEditsOf, preferredModelId, totalChange, type Part } from "@branchboard/core";

const toolPart = (id: string, tool: string, input: unknown, status = "done"): Part => ({ id, nodeId: "n", seq: 0, type: "tool", text: "", meta: { tool, input, status } });

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
    expect(edits[0].rows.filter((row) => row.kind === "gap")).toHaveLength(1);
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

  it("shows the parent folder only when file names collide", () => {
    expect(fileDisplayNames(["src/a.ts", "lib/a.ts", "b.ts"])).toEqual(["src/a.ts", "lib/a.ts", "b.ts"]);
  });
});

describe("preferred model", () => {
  const models = [{ id: "default" }, { id: "sonnet" }, { id: "claude-sonnet-5-5" }, { id: "opus" }];

  it("prefers an exact id, then a partial match", () => {
    expect(preferredModelId(models, "sonnet")).toBe("sonnet");
    expect(preferredModelId([{ id: "anthropic/claude-sonnet-5-5" }], "sonnet")).toBe("anthropic/claude-sonnet-5-5");
    expect(preferredModelId(models, "gemini")).toBeUndefined();
    expect(preferredModelId(models, " ")).toBeUndefined();
  });
});
