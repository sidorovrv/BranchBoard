import { applyPatch, emptyGraph, isRefusal, makeNode, runEdit, type BoardGraph, type GraphEdit, type Id, type Part } from "@branchboard/core";

export const BOARD = "board-1";

export const seededRandom = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};

export const mustApply = (graph: BoardGraph, edit: GraphEdit): BoardGraph => {
  const result = runEdit(graph, edit);
  if (isRefusal(result)) throw new Error(result.refusal);
  return result.graph;
};

export const withNode = (graph: BoardGraph, id: Id, parentIds: Id[] = [], overrides = {}): BoardGraph =>
  mustApply(graph, { type: "addNode", parentIds, node: makeNode(BOARD, { id, title: id, prompt: `prompt ${id}`, ...overrides }) });

export const buildGraph = (nodeIds: Id[], links: [Id, Id][]): BoardGraph => {
  let graph = emptyGraph();
  for (const id of nodeIds) graph = withNode(graph, id);
  for (const [fromId, toId] of links) graph = mustApply(graph, { type: "connect", fromId, toId });
  return graph;
};

export const finishedParts = (nodeId: Id, text: string): Part[] => [{ id: `${nodeId}:text`, nodeId, seq: 0, type: "text", text }];

export const randomDag = (random: () => number, size: number): { graph: BoardGraph; ids: Id[] } => {
  const ids = Array.from({ length: size }, (_, index) => `n${index}`);
  let graph = emptyGraph();
  ids.forEach((id) => (graph = withNode(graph, id)));
  for (let attempt = 0; attempt < size * 2; attempt++) {
    const fromId = ids[Math.floor(random() * size)];
    const toId = ids[Math.floor(random() * size)];
    const result = runEdit(graph, { type: "connect", fromId, toId });
    if (!isRefusal(result)) graph = result.graph;
  }
  return { graph, ids };
};

export { applyPatch };
