import { describe, expect, it } from "vitest";
import { addNodeEdit, makeNode, NODE_GAP, NODE_ROW_GAP, seedFrom, snapMovingBoxes, snapResizedEdges } from "../packages/core/src";
import { buildGraph, mustApply } from "./support";

const other = { x: 0, y: 0, w: 400, h: 300 };

describe("alignment snapping", () => {
  it("aligns tops when they are within the threshold", () => {
    const result = snapMovingBoxes([{ x: 600, y: 5, w: 400, h: 300 }], [other], 8);
    expect([result.dx, result.dy]).toEqual([0, -5]);
    expect(result.guides.some((guide) => guide.axis === "horizontal" && guide.position === 0)).toBe(true);
  });

  it("snaps a border that is nearly touching the other node's border exactly against it", () => {
    const result = snapMovingBoxes([{ x: 405, y: 900, w: 400, h: 300 }], [other], 8);
    expect(result.dx).toBe(-5);
  });

  it("aligns centres", () => {
    const result = snapMovingBoxes([{ x: 100, y: 700, w: 200, h: 100 }], [other], 8);
    expect(result.dx).toBe(0);
    const offCentre = snapMovingBoxes([{ x: 104, y: 700, w: 200, h: 100 }], [other], 8);
    expect(offCentre.dx).toBe(-4);
  });

  it("does nothing beyond the threshold", () => {
    expect(snapMovingBoxes([{ x: 1000, y: 1000, w: 400, h: 300 }], [other], 8)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("moves a group by the offset of its bounding box", () => {
    const result = snapMovingBoxes(
      [
        { x: 603, y: 500, w: 100, h: 100 },
        { x: 803, y: 560, w: 100, h: 100 },
      ],
      [{ x: 600, y: 0, w: 50, h: 50 }],
      8,
    );
    expect(result.dx).toBe(-3);
  });
});

describe("resize snapping", () => {
  it("snaps the dragged right and bottom edges to other nodes' edges", () => {
    const result = snapResizedEdges({ x: 600, y: 0, w: 395, h: 305 }, { horizontal: true, vertical: true }, [{ x: 0, y: 0, w: 1000, h: 300 }], 8);
    expect([result.dw, result.dh]).toEqual([5, -5]);
    expect(result.guides).toHaveLength(2);
  });

  it("ignores an axis that is not being resized", () => {
    const result = snapResizedEdges({ x: 600, y: 0, w: 395, h: 305 }, { horizontal: true, vertical: false }, [{ x: 0, y: 0, w: 1000, h: 300 }], 8);
    expect(result.dh).toBe(0);
  });
});

describe("snap on next prompt", () => {
  const board = { id: "B", title: "t", workspacePath: "", mode: "fake", createdAt: 0, updatedAt: 0, deleted: false } as const;

  it("places the reply below its parent, and further below when that spot is taken", () => {
    const parent = makeNode("B", { id: "P", x: 100, y: 100 });
    let graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: parent });
    const first = addNodeEdit(graph, board, seedFrom.reply(graph, { type: "reply", parentIds: ["P"], snapBelow: true })).node;
    expect([first.x, first.y]).toEqual([100, 100 + parent.h + NODE_ROW_GAP]);
    graph = mustApply(graph, { type: "addNode", parentIds: ["P"], node: first });
    const second = addNodeEdit(graph, board, seedFrom.reply(graph, { type: "reply", parentIds: ["P"], snapBelow: true })).node;
    expect([second.x, second.y]).toEqual([100, first.y + first.h + NODE_ROW_GAP]);
  });
});

describe("placement near the origin node", () => {
  const board = { id: "B", title: "t", workspacePath: "", mode: "fake", createdAt: 0, updatedAt: 0, deleted: false } as const;

  it("puts a regenerated sibling directly below the original, not at the bottom of the parent's column", () => {
    const parent = makeNode("B", { id: "P", x: 0, y: 0 });
    const original = makeNode("B", { id: "O", x: 780, y: 0 });
    const far = makeNode("B", { id: "F", x: 780, y: 2000 });
    let graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: parent });
    graph = mustApply(graph, { type: "addNode", parentIds: ["P"], node: original });
    graph = mustApply(graph, { type: "addNode", parentIds: ["P"], node: far });
    const sibling = addNodeEdit(graph, board, seedFrom.sibling(graph, { type: "sibling", originalId: "O" })).node;
    expect([sibling.x, sibling.y]).toEqual([780, original.h + NODE_ROW_GAP]);
  });

  it("slides below whatever is already in the way", () => {
    const parent = makeNode("B", { id: "P", x: 0, y: 0 });
    const original = makeNode("B", { id: "O", x: 780, y: 0 });
    const blocker = makeNode("B", { id: "X", x: 780, y: original.h + NODE_ROW_GAP });
    let graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: parent });
    graph = mustApply(graph, { type: "addNode", parentIds: ["P"], node: original });
    graph = mustApply(graph, { type: "addNode", parentIds: [], node: blocker });
    const sibling = addNodeEdit(graph, board, seedFrom.sibling(graph, { type: "sibling", originalId: "O" })).node;
    expect(sibling.y).toBe(blocker.y + blocker.h + NODE_ROW_GAP);
  });

  it("places a note made from a selection beside the node it came from", () => {
    const origin = makeNode("B", { id: "O", x: 100, y: 200 });
    const far = makeNode("B", { id: "F", x: 5000, y: 0 });
    let graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: origin });
    graph = mustApply(graph, { type: "addNode", parentIds: [], node: far });
    const note = addNodeEdit(graph, board, seedFrom.note(graph, { type: "note", prompt: "x", originId: "O" })).node;
    expect([note.x, note.y]).toEqual([100 + origin.w + NODE_GAP, 200]);
  });

  it("keeps the old far-right placement for a note with no origin", () => {
    const far = makeNode("B", { id: "F", x: 5000, y: 0 });
    const graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: far });
    const note = addNodeEdit(graph, board, seedFrom.note(graph, { type: "note", prompt: "x" })).node;
    expect(note.x).toBe(5000 + far.w + NODE_GAP);
  });

  it("centres an unconnected node on the visible area and slides it clear of nodes there", () => {
    const empty = buildGraph([], []);
    const first = addNodeEdit(empty, board, seedFrom.note(empty, { type: "note", prompt: "x", nearPosition: { x: 1000, y: 800 } })).node;
    expect([first.x + first.w / 2, first.y + first.h / 2]).toEqual([1000, 800]);
    const graph = mustApply(empty, { type: "addNode", parentIds: [], node: first });
    const second = addNodeEdit(graph, board, seedFrom.note(graph, { type: "note", prompt: "y", nearPosition: { x: 1000, y: 800 } })).node;
    expect(second.x).toBe(first.x);
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.h);
  });
});
