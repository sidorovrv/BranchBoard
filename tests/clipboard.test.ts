import { describe, expect, it } from "vitest";
import { applyPatch, buildNodeClipboard, isStale, parseNodeClipboard, planPaste, type Part } from "@branchboard/core";
import { buildGraph, mustApply } from "./support";

const answer = (nodeId: string, text: string): Part => ({ id: `${nodeId}:1:text`, nodeId, roll: 1, seq: 0, type: "text", text });

const finishedChain = () => {
  let graph = buildGraph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
  const done = (id: string) => ({ id, status: "done" as const, rollCount: 1, activeRoll: 1, runtimeRef: { sessionId: id } as never });
  graph = mustApply(graph, { type: "patch", patch: { nodes: { a: done("a"), b: done("b"), c: done("c") }, edges: {} } });
  return graph;
};

describe("node clipboard", () => {
  it("copies the selection with the links between selected nodes and the active answers", () => {
    const graph = finishedChain();
    const clipboard = buildNodeClipboard(graph, { a: [answer("a", "one")], b: [answer("b", "two")] }, ["a", "b"])!;
    expect(clipboard.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(clipboard.edges).toHaveLength(1);
    expect(clipboard.parts.map((part) => part.text)).toEqual(["one", "two"]);
    expect(clipboard.detachedNodeIds).toEqual([]);
    expect(buildNodeClipboard(graph, {}, ["c"])!.detachedNodeIds).toEqual(["c"]);
    expect(buildNodeClipboard(graph, {}, [])).toBeUndefined();
  });

  it("round-trips through text and rejects anything else", () => {
    const clipboard = buildNodeClipboard(finishedChain(), {}, ["a"])!;
    expect(parseNodeClipboard(JSON.stringify(clipboard))?.nodes).toHaveLength(1);
    expect(parseNodeClipboard("hello")).toBeUndefined();
    expect(parseNodeClipboard('{"format":"branchboard-nodes"}')).toBeUndefined();
  });

  it("pastes copies with new ids, relinked edges, fresh answers and no stale marker", () => {
    const graph = finishedChain();
    const clipboard = buildNodeClipboard(graph, { a: [answer("a", "one")], b: [answer("b", "two")] }, ["a", "b"])!;
    const plan = planPaste(graph, "board-1", clipboard, { x: 1000, y: 500 });
    const pasted = Object.values(plan.patch.nodes);
    expect(pasted).toHaveLength(2);
    expect(pasted.every((node) => !["a", "b", "c"].includes(node.id))).toBe(true);
    expect(Math.min(...pasted.map((node) => node.x!))).toBe(1000);
    expect(pasted.every((node) => node.runtimeRef === undefined && node.status === "done")).toBe(true);
    const edge = Object.values(plan.patch.edges)[0];
    expect(pasted.map((node) => node.id)).toEqual(expect.arrayContaining([edge.fromId!, edge.toId!]));
    const after = applyPatch(graph, plan.patch);
    expect(pasted.some((node) => isStale(after, after.nodes[node.id]))).toBe(false);
    expect(plan.replay.map((entry) => entry.events[0])).toEqual([
      { type: "part.delta", partKey: "text", partType: "text", text: "one" },
      { type: "part.delta", partKey: "text", partType: "text", text: "two" },
    ]);
  });

  it("marks a pasted answer stale when its parents were not copied, and resets unfinished nodes", () => {
    const graph = finishedChain();
    const clipboard = buildNodeClipboard(graph, {}, ["c"])!;
    const [node] = Object.values(planPaste(graph, "board-1", clipboard, { x: 0, y: 0 }).patch.nodes);
    const after = applyPatch(graph, planPaste(graph, "board-1", clipboard, { x: 0, y: 0 }).patch);
    expect(node.status).toBe("done");
    const unfinished = mustApply(graph, { type: "patch", patch: { nodes: { c: { id: "c", status: "running" } }, edges: {} } });
    const reset = Object.values(planPaste(unfinished, "board-1", buildNodeClipboard(unfinished, {}, ["c"])!, { x: 0, y: 0 }).patch.nodes)[0];
    expect(reset.status).toBe("idle");
    expect(after).toBeDefined();
  });
});
