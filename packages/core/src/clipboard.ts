import { contextHash } from "./context";
import { applyPatch, liveEdges } from "./graph";
import { indexBy, newId, now } from "./helpers";
import { activeRollOf, partsOfRoll, rollCountOf } from "./rolls";
import type { BoardGraph, GraphEdge, GraphNode, Id, Part, Patch, RunEvent, TodoItem } from "./types";
import { hasCycle, MAX_UNTRUSTED_EDGES, MAX_UNTRUSTED_NODES, MAX_UNTRUSTED_PARTS, sanitiseEdge, sanitiseList, sanitiseNode, sanitisePart } from "./untrusted";

export const NODE_CLIPBOARD_FORMAT = "branchboard-nodes";

const NODE_CLIPBOARD_VERSION = 1;
const DETACHED_CONTEXT_MARKER = "pasted-detached";
const PASTED_ROLL = 1;
const SETTLED_STATUSES: GraphNode["status"][] = ["done", "error", "interrupted"];

export interface ClipboardEdge {
  fromId: Id;
  toId: Id;
  seq: number;
}

export interface NodeClipboard {
  format: typeof NODE_CLIPBOARD_FORMAT;
  version: number;
  nodes: GraphNode[];
  edges: ClipboardEdge[];
  parts: Part[];
  detachedNodeIds: Id[];
}

export const buildNodeClipboard = (graph: BoardGraph, parts: Record<Id, Part[]>, ids: Id[]): NodeClipboard | undefined => {
  const nodes = ids.map((id) => graph.nodes[id]).filter((node) => node && !node.deleted && node.kind !== "subagent");
  if (nodes.length === 0) return undefined;
  const chosen = new Set(nodes.map((node) => node.id));
  const allEdges = liveEdges(graph);
  return {
    format: NODE_CLIPBOARD_FORMAT,
    version: NODE_CLIPBOARD_VERSION,
    nodes,
    edges: allEdges.filter((edge) => chosen.has(edge.fromId) && chosen.has(edge.toId)).map(({ fromId, toId, seq }) => ({ fromId, toId, seq })),
    parts: nodes.flatMap((node) => partsOfRoll(parts[node.id], activeRollOf(node))),
    detachedNodeIds: nodes.filter((node) => allEdges.some((edge) => edge.toId === node.id && !chosen.has(edge.fromId))).map((node) => node.id),
  };
};

export const asNodeClipboard = (raw: unknown): NodeClipboard | undefined => {
  const value = raw as NodeClipboard | undefined;
  const isValid = value?.format === NODE_CLIPBOARD_FORMAT && value.version <= NODE_CLIPBOARD_VERSION && Array.isArray(value.nodes) && Array.isArray(value.edges) && Array.isArray(value.parts) && value.nodes.length > 0;
  if (!isValid) return undefined;
  try {
    const nodes = sanitiseList(value.nodes, sanitiseNode, MAX_UNTRUSTED_NODES, "nodes");
    const nodeIds = nodes.map((node) => node.id);
    const edges = sanitiseList(value.edges, sanitiseEdge, MAX_UNTRUSTED_EDGES, "edges").filter((edge) => nodeIds.includes(edge.fromId) && nodeIds.includes(edge.toId) && edge.fromId !== edge.toId);
    if (new Set(nodeIds).size !== nodes.length || hasCycle(nodeIds, edges)) return undefined;
    const parts = sanitiseList(value.parts, sanitisePart, MAX_UNTRUSTED_PARTS, "parts");
    const detachedNodeIds = (Array.isArray(value.detachedNodeIds) ? value.detachedNodeIds : []).filter((id): id is Id => typeof id === "string");
    return { format: NODE_CLIPBOARD_FORMAT, version: value.version, nodes, edges, parts, detachedNodeIds };
  } catch {
    return undefined;
  }
};

export const parseNodeClipboard = (text: string): NodeClipboard | undefined => {
  if (!text.includes(NODE_CLIPBOARD_FORMAT)) return undefined;
  try {
    return asNodeClipboard(JSON.parse(text));
  } catch {
    return undefined;
  }
};

const partKeyOf = (part: Part, nodeId: Id): string => {
  const prefix = part.roll === undefined ? `${nodeId}:` : `${nodeId}:${part.roll}:`;
  return part.id.startsWith(prefix) ? part.id.slice(prefix.length) : part.id;
};

const replayEventsOf = (part: Part, partKey: string): RunEvent[] => {
  if (part.type === "text" || part.type === "reasoning") return [{ type: "part.delta", partKey, partType: part.type, text: part.text }];
  if (part.type === "error") return [{ type: "error", message: part.text }];
  if (part.type === "todo") return [{ type: "todos", items: (part.meta?.items ?? []) as TodoItem[] }];
  const isError = part.meta?.status === "error";
  return [
    { type: "tool.started", partKey, tool: String(part.meta?.tool ?? ""), description: part.text, input: part.meta?.input },
    { type: "tool.done", partKey, output: part.meta?.output === undefined ? "" : String(part.meta.output), isError },
  ];
};

const pastedNodeFields = (node: GraphNode, id: Id, boardId: Id, offset: { x: number; y: number }, remap: (id: Id) => Id): GraphNode => {
  const isSettled = node.kind === "turn" && SETTLED_STATUSES.includes(node.status) && rollCountOf(node) > 0;
  return {
    ...node,
    id,
    boardId,
    x: node.x + offset.x,
    y: node.y + offset.y,
    status: isSettled ? node.status : node.kind === "turn" ? "idle" : node.status,
    collapsed: false,
    pinned: false,
    runtimeRef: undefined,
    summary: undefined,
    satelliteOf: undefined,
    rolls: undefined,
    activeRoll: isSettled ? PASTED_ROLL : undefined,
    rollCount: isSettled ? PASTED_ROLL : undefined,
    contextNodeIds: node.contextNodeIds?.map(remap),
    ...(isSettled ? {} : { usage: undefined, stopped: undefined, startedAt: undefined, completedAt: undefined, contextHash: undefined, contextMode: undefined }),
    createdAt: now(),
    deleted: false,
    deletedAt: undefined,
  };
};

export interface PastePlan {
  patch: Patch;
  nodeIds: Id[];
  replay: { nodeId: Id; events: RunEvent[] }[];
}

export const planPaste = (graph: BoardGraph, boardId: Id, clipboard: NodeClipboard, anchor: { x: number; y: number }): PastePlan => {
  const idMap = new Map(clipboard.nodes.map((node) => [node.id, newId()]));
  const remap = (id: Id): Id => idMap.get(id) ?? id;
  const offset = { x: anchor.x - Math.min(...clipboard.nodes.map((node) => node.x)), y: anchor.y - Math.min(...clipboard.nodes.map((node) => node.y)) };
  const nodes = clipboard.nodes.map((node) => pastedNodeFields(node, remap(node.id), boardId, offset, remap));
  const edges: GraphEdge[] = clipboard.edges
    .filter((edge) => idMap.has(edge.fromId) && idMap.has(edge.toId))
    .map((edge) => ({ id: newId(), boardId, fromId: remap(edge.fromId), toId: remap(edge.toId), seq: edge.seq, createdAt: now(), deleted: false }));
  const patch: Patch = { nodes: indexBy(nodes, (node) => node.id), edges: indexBy(edges, (edge) => edge.id) };
  const working = applyPatch(graph, patch);
  const detached = new Set(clipboard.detachedNodeIds.map(remap));
  nodes.forEach((node, index) => {
    const source = clipboard.nodes[index];
    if (node.status === "done" && source.contextHash !== undefined) patch.nodes[node.id] = { ...node, contextHash: detached.has(node.id) ? DETACHED_CONTEXT_MARKER : contextHash(working, node.id) };
  });
  const replay = clipboard.nodes
    .map((source) => ({
      nodeId: remap(source.id),
      events: clipboard.parts.filter((part) => part.nodeId === source.id).flatMap((part) => replayEventsOf(part, partKeyOf(part, source.id))),
    }))
    .filter((entry) => entry.events.length > 0 && patch.nodes[entry.nodeId].activeRoll === PASTED_ROLL);
  return { patch, nodeIds: nodes.map((node) => node.id), replay };
};
