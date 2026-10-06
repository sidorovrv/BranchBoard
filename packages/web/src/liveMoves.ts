import { useMemo } from "react";
import { create } from "zustand";
import type { BoardGraph } from "@branchboard/core";
import { useBoard } from "./store";

type Positions = Record<string, { x: number; y: number }>;

interface LiveMoveStore {
  positions: Positions;
  update: (moved: Positions) => void;
  clear: () => void;
}

export const useLiveMoves = create<LiveMoveStore>((set) => ({
  positions: {},
  update: (moved) => set((state) => ({ positions: { ...state.positions, ...moved } })),
  clear: () => set((state) => (Object.keys(state.positions).length === 0 ? state : { positions: {} })),
}));

export const withLiveMoves = (graph: BoardGraph, positions: Positions): BoardGraph => {
  const ids = Object.keys(positions).filter((id) => graph.nodes[id]);
  if (ids.length === 0) return graph;
  return { ...graph, nodes: { ...graph.nodes, ...Object.fromEntries(ids.map((id) => [id, { ...graph.nodes[id], ...positions[id] }])) } };
};

export const useGraphWithLiveMoves = (): BoardGraph => {
  const graph = useBoard((state) => state.view.graph);
  const positions = useLiveMoves((state) => state.positions);
  return useMemo(() => withLiveMoves(graph, positions), [graph, positions]);
};
