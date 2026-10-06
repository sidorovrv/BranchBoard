import { liveEdges } from "./graph";
import type { BoardGraph, GraphNode } from "./types";

export type FlowDirection = "horizontal" | "vertical";

export const FLOW_DIRECTIONS: FlowDirection[] = ["horizontal", "vertical"];

export type Side = "left" | "right" | "top" | "bottom";

export const SIDES: Side[] = ["left", "right", "top", "bottom"];

export interface WireSides {
  fromSide: Side;
  toSide: Side;
}

type Box = Pick<GraphNode, "x" | "y" | "w" | "h">;

const preferredSides = (direction: FlowDirection): { before: Side; after: Side } =>
  direction === "horizontal" ? { before: "left", after: "right" } : { before: "top", after: "bottom" };

const crossSides = (direction: FlowDirection): { before: Side; after: Side } => preferredSides(direction === "horizontal" ? "vertical" : "horizontal");

const spanOf = (box: Box, direction: FlowDirection) => (direction === "horizontal" ? { start: box.x, size: box.w } : { start: box.y, size: box.h });

export const wireSidesOf = (from: Box, to: Box, direction: FlowDirection): WireSides => {
  const main = preferredSides(direction);
  const fromSpan = spanOf(from, direction);
  const toSpan = spanOf(to, direction);
  if (toSpan.start >= fromSpan.start + fromSpan.size) return { fromSide: main.after, toSide: main.before };
  if (toSpan.start + toSpan.size <= fromSpan.start) return { fromSide: main.before, toSide: main.after };
  const cross = crossSides(direction);
  const crossDirection = direction === "horizontal" ? "vertical" : "horizontal";
  const fromCentre = spanOf(from, crossDirection).start + spanOf(from, crossDirection).size / 2;
  const toCentre = spanOf(to, crossDirection).start + spanOf(to, crossDirection).size / 2;
  return toCentre >= fromCentre ? { fromSide: cross.after, toSide: cross.before } : { fromSide: cross.before, toSide: cross.after };
};

export const wireSidesByEdge = (graph: BoardGraph, direction: FlowDirection): Map<string, WireSides> => {
  const sides = new Map<string, WireSides>();
  for (const edge of liveEdges(graph)) {
    const from = graph.nodes[edge.fromId];
    const to = graph.nodes[edge.toId];
    if (from && to) sides.set(edge.id, wireSidesOf(from, to, direction));
  }
  return sides;
};

export interface SatelliteLink {
  satelliteId: string;
  parentId: string;
  sides: WireSides;
}

export const satelliteLinksOf = (graph: BoardGraph, direction: FlowDirection): SatelliteLink[] =>
  Object.values(graph.nodes).flatMap((node) => {
    const parent = node.satelliteOf === undefined ? undefined : graph.nodes[node.satelliteOf];
    return node.deleted || !parent || parent.deleted ? [] : [{ satelliteId: node.id, parentId: parent.id, sides: wireSidesOf(parent, node, direction) }];
  });

export const usedSidesOf = (graph: BoardGraph, nodeId: string, direction: FlowDirection): Set<Side> => {
  const used = new Set<Side>();
  for (const edge of liveEdges(graph)) {
    if (edge.fromId !== nodeId && edge.toId !== nodeId) continue;
    const sides = wireSidesOf(graph.nodes[edge.fromId], graph.nodes[edge.toId], direction);
    used.add(edge.fromId === nodeId ? sides.fromSide : sides.toSide);
  }
  for (const link of satelliteLinksOf(graph, direction)) {
    if (link.parentId === nodeId) used.add(link.sides.fromSide);
    if (link.satelliteId === nodeId) used.add(link.sides.toSide);
  }
  return used;
};

export interface ConnectedEdge {
  edgeId: string;
  otherNodeId: string;
}

export const edgesAtSide = (graph: BoardGraph, nodeId: string, side: Side, direction: FlowDirection): ConnectedEdge[] =>
  liveEdges(graph).flatMap((edge) => {
    if (edge.fromId !== nodeId && edge.toId !== nodeId) return [];
    const sides = wireSidesOf(graph.nodes[edge.fromId], graph.nodes[edge.toId], direction);
    if (edge.fromId === nodeId) return sides.fromSide === side ? [{ edgeId: edge.id, otherNodeId: edge.toId }] : [];
    return sides.toSide === side ? [{ edgeId: edge.id, otherNodeId: edge.fromId }] : [];
  });

export const isOnFlowAxis = (side: Side, direction: FlowDirection): boolean => (direction === "horizontal" ? side === "left" || side === "right" : side === "top" || side === "bottom");

export const isOutputSide = (side: Side): boolean => side === "right" || side === "bottom";
