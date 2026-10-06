import { contextHash, isStale } from "./context";
import { liveEdges, liveNodes } from "./graph";
import { indexBy, newId } from "./helpers";
import type { Board, BoardDocument, BoardGraph, GraphEdge, GraphNode, Id, Part } from "./types";
import { hasCycle, MAX_UNTRUSTED_EDGES, MAX_UNTRUSTED_NODES, MAX_UNTRUSTED_PARTS, sanitiseEdge, sanitiseList, sanitiseNode, sanitisePart } from "./untrusted";

const DOCUMENT_VERSION = 1;
const DOCUMENT_FORMAT = "branchboard";
const LEGACY_DOCUMENT_FORMAT = "wanderboard";

export interface BoardSnapshot {
  board: Board;
  graph: BoardGraph;
  parts: Record<Id, Part[]>;
}

export const collectBoard = ({ board, graph, parts }: BoardSnapshot): BoardDocument => {
  const nodes = liveNodes(graph);
  return {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    board,
    nodes,
    edges: liveEdges(graph),
    parts: nodes.flatMap((node) => parts[node.id] ?? []),
    staleNodeIds: nodes.filter((node) => isStale(graph, node)).map((node) => node.id),
  };
};

export const encoders: Record<string, (document: BoardDocument) => string> = {
  json: (document) => JSON.stringify(document, null, 2),
};

export const decoders: Record<string, (raw: string) => unknown> = {
  json: (raw) => JSON.parse(raw),
};

const isDocument = (value: unknown): value is BoardDocument => {
  const candidate = value as Omit<BoardDocument, "format"> & { format?: string };
  return (
    (candidate?.format === DOCUMENT_FORMAT || candidate?.format === LEGACY_DOCUMENT_FORMAT) &&
    typeof candidate.version === "number" &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges) &&
    Array.isArray(candidate.parts) &&
    typeof candidate.board === "object"
  );
};

export const validateDocument = (value: unknown): BoardDocument => {
  if (!isDocument(value)) throw new Error("Not a Branchboard export");
  if (value.version > DOCUMENT_VERSION) throw new Error(`Export version ${value.version} is newer than this app understands`);
  return { ...value, format: DOCUMENT_FORMAT };
};

const migrations: Record<number, (document: BoardDocument) => BoardDocument> = {};

export const migrateDocument = (document: BoardDocument): BoardDocument => {
  let current = document;
  while (current.version < DOCUMENT_VERSION) {
    const step = migrations[current.version];
    if (!step) throw new Error(`No migration from version ${current.version}`);
    current = { ...step(current), version: current.version + 1 };
  }
  return current;
};

const STALE_MARKER = "imported-stale";
const MAX_TITLE_CHARS = 200;

export interface ImportedBoard {
  boardId: Id;
  title: string;
  graph: BoardGraph;
  parts: Record<Id, Part[]>;
}

export const sanitiseDocument = (document: BoardDocument): BoardDocument => {
  const nodes = sanitiseList(document.nodes, sanitiseNode, MAX_UNTRUSTED_NODES, "nodes");
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new Error("Two nodes share one id");
  const edges = sanitiseList(document.edges, sanitiseEdge, MAX_UNTRUSTED_EDGES, "edges")
    .filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId) && edge.fromId !== edge.toId)
    .map((edge) => ({ ...edge, id: "", boardId: "", createdAt: 0, deleted: false }));
  if (hasCycle([...nodeIds], edges)) throw new Error("The connections form a loop");
  const parts = sanitiseList(document.parts, sanitisePart, MAX_UNTRUSTED_PARTS, "parts").filter((part) => nodeIds.has(part.nodeId));
  const staleNodeIds = (Array.isArray(document.staleNodeIds) ? document.staleNodeIds : []).filter((id): id is Id => typeof id === "string");
  const title = typeof document.board?.title === "string" ? document.board.title.slice(0, MAX_TITLE_CHARS) : "";
  return { ...document, board: { ...document.board, title }, nodes, edges, parts, staleNodeIds };
};

export const reidentifyDocument = (document: BoardDocument, title?: string): ImportedBoard => {
  const boardId = newId();
  const nodeIds = new Map(document.nodes.map((node) => [node.id, newId()]));
  const remap = (id: Id): Id => nodeIds.get(id) ?? id;
  const nodes: GraphNode[] = document.nodes.map((node) => ({
    ...node,
    id: remap(node.id),
    boardId,
    runtimeRef: undefined,
    attachments: undefined,
    satelliteOf: node.satelliteOf === undefined ? undefined : nodeIds.get(node.satelliteOf),
    contextNodeIds: node.contextNodeIds?.map(remap),
    contextHash: node.contextHash === undefined ? undefined : STALE_MARKER,
    status: node.status === "done" ? "done" : node.kind === "turn" ? "interrupted" : node.status,
  }));
  const edges: GraphEdge[] = document.edges.map((edge) => ({ ...edge, id: newId(), boardId, fromId: remap(edge.fromId), toId: remap(edge.toId) }));
  const parts: Part[] = document.parts.map((part) => ({ ...part, id: part.id.replace(part.nodeId, remap(part.nodeId)), nodeId: remap(part.nodeId) }));
  const graph: BoardGraph = { nodes: indexBy(nodes, (node) => node.id), edges: indexBy(edges, (edge) => edge.id) };
  const staleIds = new Set(document.staleNodeIds.map(remap));
  const settled = nodes.map((node) =>
    node.contextHash === STALE_MARKER && !staleIds.has(node.id) ? { ...node, contextHash: contextHash(graph, node.id) } : node,
  );
  const partsByNode: Record<Id, Part[]> = {};
  parts.forEach((part) => (partsByNode[part.nodeId] = [...(partsByNode[part.nodeId] ?? []), part]));
  return { boardId, title: title ?? `${document.board.title} (imported)`, graph: { ...graph, nodes: indexBy(settled, (node) => node.id) }, parts: partsByNode };
};

export const importBoardDocument = (raw: string, format = "json", title?: string): ImportedBoard =>
  reidentifyDocument(sanitiseDocument(migrateDocument(validateDocument(decoders[format](raw)))), title);
