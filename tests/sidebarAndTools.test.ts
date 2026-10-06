import { describe, expect, it } from "vitest";
import { applyOrder, describeToolGroup, groupToolRuns, moveWithin, toolGroupStatus, type Part } from "@branchboard/core";

const toolPart = (id: string, tool: string, status = "done"): Part => ({ id, nodeId: "n", seq: 0, type: "tool", text: "", meta: { tool, status } });
const textPart = (id: string): Part => ({ id, nodeId: "n", seq: 0, type: "text", text: "hello" });

describe("tool call grouping", () => {
  it("groups consecutive tool parts and keeps other parts single", () => {
    const runs = groupToolRuns([textPart("a"), toolPart("b", "Read"), toolPart("c", "Bash"), textPart("d"), toolPart("e", "Read")]);
    expect(runs.map((run) => run.kind)).toEqual(["single", "tools", "single", "tools"]);
    expect(runs[1].kind === "tools" && runs[1].parts.map((part) => part.id)).toEqual(["b", "c"]);
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

describe("sidebar ordering", () => {
  const items = ["a", "b", "c", "d"].map((id) => ({ id }));

  it("puts unlisted items first or last and drops unknown ids", () => {
    expect(applyOrder(items, ["c", "x", "a"], true).map((item) => item.id)).toEqual(["b", "d", "c", "a"]);
    expect(applyOrder(items, ["c", "a"], false).map((item) => item.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("moves an id before or after a target", () => {
    expect(moveWithin(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(moveWithin(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(moveWithin(["a", "b", "c"], "a", "a", "after")).toEqual(["a", "b", "c"]);
    expect(moveWithin(["a", "b", "c"], "z", "a", "after")).toEqual(["a", "b", "c"]);
  });
});
