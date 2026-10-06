import { useCallback, useEffect, useRef } from "react";
import { useReactFlow, useViewport, ViewportPortal, type Node, type NodeChange } from "@xyflow/react";
import { create } from "zustand";
import { hiddenByCollapse, liveNodes, minSizeOf, snapMovingBoxes, snapResizedEdges, type Box, type GraphNode, type Guide } from "@branchboard/core";
import { useBoard } from "./store";

const SNAP_SCREEN_PX = 8;
const GUIDE_SCREEN_PX = 1.5;
const NO_OFFSET = { dx: 0, dy: 0 };

type PositionChange = Extract<NodeChange, { type: "position" }> & { position: { x: number; y: number } };

const isPositionChange = (change: NodeChange): change is PositionChange => change.type === "position" && change.position !== undefined;

const boxOf = (node: GraphNode, position: { x: number; y: number } = node): Box => ({
  x: position.x,
  y: position.y,
  w: Math.max(node.w, minSizeOf(node.kind).w),
  h: Math.max(node.h, minSizeOf(node.kind).h),
});

const shifted = (changes: NodeChange[], { dx, dy }: { dx: number; dy: number }): NodeChange[] =>
  dx === 0 && dy === 0 ? changes : changes.map((change) => (isPositionChange(change) ? { ...change, position: { x: Math.round(change.position.x + dx), y: Math.round(change.position.y + dy) } } : change));

const sameGuides = (first: Guide[], second: Guide[]): boolean => first.length === second.length && first.every((guide, index) => JSON.stringify(guide) === JSON.stringify(second[index]));

interface GuideStore {
  guides: Guide[];
  show: (next: Guide[]) => void;
}

export const useGuides = create<GuideStore>((set) => ({
  guides: [],
  show: (next) => set((state) => (sameGuides(state.guides, next) ? state : { guides: next })),
}));

export const snapResize = (node: GraphNode, size: { w: number; h: number }, axes: { horizontal: boolean; vertical: boolean }, zoom: number): { w: number; h: number } => {
  const graph = useBoard.getState().view.graph;
  const hidden = hiddenByCollapse(graph);
  const others = liveNodes(graph).filter((other) => other.id !== node.id && !hidden.has(other.id)).map((other) => boxOf(other));
  const result = snapResizedEdges({ x: node.x, y: node.y, ...size }, axes, others, SNAP_SCREEN_PX / zoom);
  useGuides.getState().show(result.guides);
  return { w: Math.round(size.w + result.dw), h: Math.round(size.h + result.dh) };
};

export const clearGuides = () => useGuides.getState().show([]);

export const useDragSnap = () => {
  const { getViewport } = useReactFlow();
  const isAltHeld = useRef(false);
  const isDragging = useRef(false);
  const offset = useRef(NO_OFFSET);
  const guides = useGuides((state) => state.guides);
  const showGuides = useGuides((state) => state.show);

  useEffect(() => {
    const trackAlt = (event: KeyboardEvent) => {
      isAltHeld.current = event.altKey;
      if (event.type === "keyup" && event.key === "Alt" && isDragging.current) event.preventDefault();
    };
    const releaseAlt = () => (isAltHeld.current = false);
    window.addEventListener("keydown", trackAlt);
    window.addEventListener("keyup", trackAlt);
    window.addEventListener("blur", releaseAlt);
    return () => {
      window.removeEventListener("keydown", trackAlt);
      window.removeEventListener("keyup", trackAlt);
      window.removeEventListener("blur", releaseAlt);
    };
  }, []);

  const startDrag = useCallback(() => {
    isDragging.current = true;
    offset.current = NO_OFFSET;
  }, []);

  const adjustChanges = useCallback(
    (changes: NodeChange[]): NodeChange[] => {
      const moves = changes.filter(isPositionChange);
      if (moves.length === 0) return changes;
      if (moves.every((move) => move.dragging === false)) return shifted(changes, offset.current);
      if (!isAltHeld.current) {
        offset.current = NO_OFFSET;
        showGuides([]);
        return changes;
      }
      const graph = useBoard.getState().view.graph;
      const movedIds = new Set(moves.map((move) => move.id));
      const hidden = hiddenByCollapse(graph);
      const moving = moves.filter((move) => graph.nodes[move.id]).map((move) => boxOf(graph.nodes[move.id], move.position));
      const others = liveNodes(graph).filter((node) => !movedIds.has(node.id) && !hidden.has(node.id)).map((node) => boxOf(node));
      const result = snapMovingBoxes(moving, others, SNAP_SCREEN_PX / getViewport().zoom);
      offset.current = { dx: result.dx, dy: result.dy };
      showGuides(result.guides);
      return shifted(changes, offset.current);
    },
    [getViewport, showGuides],
  );

  const finishDrag = useCallback(
    (dragged: Node[]): Record<string, { x: number; y: number }> => {
      const { dx, dy } = offset.current;
      isDragging.current = false;
      offset.current = NO_OFFSET;
      showGuides([]);
      return Object.fromEntries(dragged.map((node) => [node.id, dx === 0 && dy === 0 ? node.position : { x: Math.round(node.position.x + dx), y: Math.round(node.position.y + dy) }]));
    },
    [showGuides],
  );

  return { guides, adjustChanges, startDrag, finishDrag };
};

export const AlignmentGuides = ({ guides }: { guides: Guide[] }) => {
  const { zoom } = useViewport();
  const thickness = GUIDE_SCREEN_PX / zoom;
  if (guides.length === 0) return null;
  return (
    <ViewportPortal>
      {guides.map((guide) => (
        <div
          key={`${guide.axis}:${guide.position}`}
          className="alignment-guide"
          style={
            guide.axis === "vertical"
              ? { left: guide.position - thickness / 2, top: guide.from, width: thickness, height: guide.to - guide.from }
              : { left: guide.from, top: guide.position - thickness / 2, width: guide.to - guide.from, height: thickness }
          }
        />
      ))}
    </ViewportPortal>
  );
};
