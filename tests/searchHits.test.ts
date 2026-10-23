import { describe, expect, it } from "vitest";
import type { GraphNode, Part } from "@branchboard/core";
import { hitsOfNode } from "../packages/web/src/searchHits";

const node = { id: "n1", kind: "turn", title: "Query planner", prompt: "Explain the planner" } as unknown as GraphNode;

const part = (overrides: Partial<Part>): Part => ({ id: "p", seq: 0, type: "text", text: "", nodeId: "n1", ...overrides }) as Part;

describe("hitsOfNode", () => {
  it("reports title, prompt, answer and tool hits with surrounding text", () => {
    const parts = [
      part({ id: "a", type: "text", text: "The planner picks an index scan." }),
      part({ id: "b", type: "tool", text: "Bash", meta: { tool: "Bash", input: { command: "grep planner src" }, output: "src/planner.ts" } }),
    ];
    const hits = hitsOfNode(node, parts, "planner");
    expect(hits.map((hit) => hit.field)).toEqual(["title", "prompt", "answer", "tool", "tool"]);
    expect(hits[2]).toMatchObject({ before: "The ", match: "planner", after: " picks an index scan." });
    expect(hits[3]).toMatchObject({ toolName: "Bash", toolOrdinal: 0 });
  });

  it("numbers identical contexts so repeated matches stay distinguishable", () => {
    const hits = hitsOfNode(node, [part({ type: "text", text: "go go" })], "go");
    expect(hits.filter((hit) => hit.field === "answer").map((hit) => hit.occurrence)).toEqual([0, 1]);
  });
});
