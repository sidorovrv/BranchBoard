import { describe, expect, it } from "vitest";
import { edgesAtSide, liveNodes, makeNode, NODE_GAP, placeNode, satelliteLinksOf, usedSidesOf, wireSidesOf } from "../packages/core/src";
import { mustApply, buildGraph } from "./support";

const box = (x: number, y: number) => ({ x, y, w: 100, h: 100 });

describe("connections at a side and satellites", () => {
  const graphWithParent = () => {
    let graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: makeNode("B", { id: "P", x: 0, y: 0 }) });
    graph = mustApply(graph, { type: "addNode", parentIds: ["P"], node: makeNode("B", { id: "C1", x: 2400, y: 0 }) });
    return mustApply(graph, { type: "addNode", parentIds: ["P"], node: makeNode("B", { id: "C2", x: 2400, y: 500 }) });
  };

  it("lists the edges drawn at one side of a node", () => {
    const graph = graphWithParent();
    expect(edgesAtSide(graph, "P", "right", "horizontal").map((edge) => edge.otherNodeId).sort()).toEqual(["C1", "C2"]);
    expect(edgesAtSide(graph, "P", "left", "horizontal")).toEqual([]);
    expect(edgesAtSide(graph, "C1", "left", "horizontal").map((edge) => edge.otherNodeId)).toEqual(["P"]);
  });

  it("places a satellite like a reply: beside its parent, else the nearest free spot above or below", () => {
    let graph = graphWithParent();
    const parent = graph.nodes.P;
    const size = { w: 360, h: 240 };
    const first = placeNode(graph, ["P"], size);
    expect(first).toEqual({ x: parent.x + parent.w + NODE_GAP, y: parent.y });
    graph = mustApply(graph, { type: "addNode", parentIds: [], node: makeNode("B", { id: "S1", kind: "subagent", satelliteOf: "P", ...size, ...first }) });
    expect(placeNode(graph, ["P"], size).y).toBeGreaterThanOrEqual(first.y + size.h);
  });

  it("places a satellite above its parent's row when the column beside it is full below", () => {
    let graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: makeNode("B", { id: "P", x: 0, y: 0 }) });
    const parent = graph.nodes.P;
    const column = parent.x + parent.w + NODE_GAP;
    ["A", "B", "C"].forEach((id, row) => (graph = mustApply(graph, { type: "addNode", parentIds: [], node: makeNode("B", { id, x: column, y: 100 + row * 400 }) })));
    const size = { w: 360, h: 240 };
    const spot = placeNode(graph, ["P"], size);
    expect(spot.x).toBe(column);
    expect(spot.y + size.h).toBeLessThanOrEqual(100);
  });

  it("places an unconnected node at the nearest free spot, above the crowd when that is closer", () => {
    let graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: makeNode("B", { id: "top", x: 0, y: 0, w: 700, h: 360 }) });
    ["a", "b", "c", "d"].forEach((id, row) => (graph = mustApply(graph, { type: "addNode", parentIds: [], node: makeNode("B", { id, x: 0, y: 400 + row * 400, w: 700, h: 360 }) })));
    const size = { w: 350, h: 120 };
    const spot = placeNode(graph, [], size, undefined, { x: 350, y: 1000 });
    expect(Math.hypot(spot.x - (350 - size.w / 2), spot.y - (1000 - size.h / 2))).toBeLessThan(800);
    expect(liveNodes(graph).some((node) => spot.x < node.x + node.w && node.x < spot.x + size.w && spot.y < node.y + node.h && node.y < spot.y + size.h)).toBe(false);
  });

  it("links a satellite to its parent on the flow axis and counts the sides as used", () => {
    let graph = graphWithParent();
    graph = mustApply(graph, { type: "addNode", parentIds: [], node: makeNode("B", { id: "S1", kind: "subagent", satelliteOf: "P", x: 1000, y: 0, w: 360, h: 240 }) });
    expect(satelliteLinksOf(graph, "horizontal")).toEqual([{ satelliteId: "S1", parentId: "P", sides: { fromSide: "right", toSide: "left" } }]);
    expect(usedSidesOf(graph, "S1", "horizontal").has("left")).toBe(true);
  });
});

describe("wire sides", () => {
  it("uses the flow axis when the nodes are apart along it", () => {
    expect(wireSidesOf(box(0, 0), box(200, 300), "horizontal")).toEqual({ fromSide: "right", toSide: "left" });
    expect(wireSidesOf(box(200, 0), box(0, 0), "horizontal")).toEqual({ fromSide: "left", toSide: "right" });
    expect(wireSidesOf(box(0, 0), box(300, 200), "vertical")).toEqual({ fromSide: "bottom", toSide: "top" });
  });

  it("switches to the other axis when the nodes overlap along the flow axis", () => {
    expect(wireSidesOf(box(0, 0), box(20, 200), "horizontal")).toEqual({ fromSide: "bottom", toSide: "top" });
    expect(wireSidesOf(box(0, 200), box(20, 0), "horizontal")).toEqual({ fromSide: "top", toSide: "bottom" });
    expect(wireSidesOf(box(0, 0), box(200, 20), "vertical")).toEqual({ fromSide: "right", toSide: "left" });
  });
});
