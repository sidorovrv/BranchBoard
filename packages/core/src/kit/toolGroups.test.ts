import { describe, expect, it } from "vitest";
import { describeToolGroup, groupToolRuns, toolGroupStatus } from "./toolGroups";
import type { ChatPart } from "./types";

const toolPart = (id: string, tool: string, status = "done"): ChatPart => ({ id, seq: 0, type: "tool", text: "", meta: { tool, status } });
const textPart = (id: string): ChatPart => ({ id, seq: 0, type: "text", text: "hello" });

describe("tool call grouping", () => {
  it("groups consecutive tool parts and keeps other parts single", () => {
    const runs = groupToolRuns([textPart("a"), toolPart("b", "Read"), toolPart("c", "Bash"), textPart("d"), toolPart("e", "Read")]);
    expect(runs.map((run) => run.kind)).toEqual(["single", "tools", "single", "tools"]);
    const grouped = runs[1];
    expect(grouped?.kind === "tools" && grouped.parts.map((part) => part.id)).toEqual(["b", "c"]);
  });

  it("groups all tool calls between two text parts, whatever the tool or the parts between them", () => {
    const reasoningPart = (id: string): ChatPart => ({ id, seq: 0, type: "reasoning", text: "hmm" });
    const runs = groupToolRuns([textPart("a"), toolPart("b", "Read"), reasoningPart("c"), toolPart("d", "Edit"), toolPart("e", "Bash"), textPart("f")]);
    expect(runs.map((run) => run.kind)).toEqual(["single", "tools", "single", "single"]);
    const grouped = runs[1];
    expect(grouped?.kind === "tools" && grouped.parts.map((part) => part.id)).toEqual(["b", "d", "e"]);
    expect(describeToolGroup(grouped?.kind === "tools" ? grouped.parts : [])).toBe("Read 1 file, edited 1 file, ran a command");
  });

  it("describes a group by what the tools did", () => {
    const parts = [toolPart("1", "Read"), toolPart("2", "Read"), toolPart("3", "Read"), toolPart("4", "Bash"), toolPart("5", "Grep"), toolPart("6", "Mystery")];
    expect(describeToolGroup(parts)).toBe("Read 3 files, searched, ran a command, used Mystery");
  });

  it("reports running while any call is running and error when one failed", () => {
    expect(toolGroupStatus([toolPart("1", "Read"), toolPart("2", "Bash", "running")])).toBe("running");
    expect(toolGroupStatus([toolPart("1", "Read", "error"), toolPart("2", "Bash", "running")])).toBe("error");
    expect(toolGroupStatus([toolPart("1", "Read")])).toBe("done");
  });
});
