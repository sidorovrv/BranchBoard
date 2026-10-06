import { RUN_CHOICE_KEYS } from "./choices";
import { indexBy, isRefusal, mapValues, newId, now, refuse, sameMembers, sortBy, unique, type Refusal } from "./helpers";
import { canSelectRoll, rollPatchForDiscard, rollPatchForQueue, rollPatchForSelect } from "./rolls";
import type { BoardGraph, EdgePatch, GraphEdge, GraphEdit, GraphNode, Id, NodePatch, NodeStatus, Patch } from "./types";

export const NODE_WIDTH = 700;
export const NODE_HEIGHT = 360;
export const NODE_MIN_WIDTH = 360;
export const NODE_MAX_WIDTH = 3600;
export const NODE_MAX_HEIGHT = 2400;
export const NODE_MIN_HEIGHT = 240;
export const NOTE_MIN_WIDTH = NODE_MIN_WIDTH / 4;
export const NOTE_MIN_HEIGHT = NODE_MIN_HEIGHT / 4;
export const NOTE_WIDTH = NODE_WIDTH / 2;
export const NOTE_HEIGHT = NODE_MIN_HEIGHT / 2;
export const NODE_GAP = 80;

export const minSizeOf = (kind: GraphNode["kind"]): { w: number; h: number } =>
  kind === "context" ? { w: NOTE_MIN_WIDTH, h: NOTE_MIN_HEIGHT } : { w: NODE_MIN_WIDTH, h: NODE_MIN_HEIGHT };
export const NODE_ROW_GAP = 40;

export const emptyGraph = (): BoardGraph => ({ nodes: {}, edges: {} });

export const makeNode = (boardId: Id, overrides: Partial<GraphNode> = {}): GraphNode => ({
  id: newId(),
  boardId,
  kind: "turn",
  status: "idle",
  title: "",
  prompt: "",
  x: 0,
  y: 0,
  w: NODE_WIDTH,
  h: NODE_HEIGHT,
  collapsed: false,
  forceAssemble: false,
  rev: 0,
  createdAt: now(),
  deleted: false,
  ...overrides,
});

const makeEdge = (boardId: Id, fromId: Id, toId: Id, seq: number): GraphEdge => ({
  id: newId(),
  boardId,
  fromId,
  toId,
  seq,
  createdAt: now(),
  deleted: false,
});

export const liveNodes = (graph: BoardGraph): GraphNode[] => Object.values(graph.nodes).filter((node) => !node.deleted);

export const liveEdges = (graph: BoardGraph, ignoreEdgeId?: Id): GraphEdge[] =>
  Object.values(graph.edges).filter(
    (edge) =>
      edge.id !== ignoreEdgeId && !edge.deleted && graph.nodes[edge.fromId] && !graph.nodes[edge.fromId].deleted && graph.nodes[edge.toId] && !graph.nodes[edge.toId].deleted,
  );

export interface Adjacency {
  parents: Map<Id, GraphEdge[]>;
  children: Map<Id, GraphEdge[]>;
}

const buildAdjacency = (graph: BoardGraph, ignoreEdgeId?: Id): Adjacency => {
  const parents = new Map<Id, GraphEdge[]>();
  const children = new Map<Id, GraphEdge[]>();
  for (const edge of sortBy(liveEdges(graph, ignoreEdgeId), (edge) => edge.seq, (edge) => edge.createdAt)) {
    parents.set(edge.toId, [...(parents.get(edge.toId) ?? []), edge]);
    children.set(edge.fromId, [...(children.get(edge.fromId) ?? []), edge]);
  }
  return { parents, children };
};

const adjacencyCache = new WeakMap<BoardGraph, Adjacency>();

export const adjacencyOf = (graph: BoardGraph, ignoreEdgeId?: Id): Adjacency => {
  if (ignoreEdgeId) return buildAdjacency(graph, ignoreEdgeId);
  const cached = adjacencyCache.get(graph);
  if (cached) return cached;
  const built = buildAdjacency(graph);
  adjacencyCache.set(graph, built);
  return built;
};

export const incomingEdges = (graph: BoardGraph, id: Id): GraphEdge[] => adjacencyOf(graph).parents.get(id) ?? [];

export const parentIdsOf = (graph: BoardGraph, id: Id): Id[] => incomingEdges(graph, id).map((edge) => edge.fromId);

export const childIdsOf = (graph: BoardGraph, id: Id): Id[] => (adjacencyOf(graph).children.get(id) ?? []).map((edge) => edge.toId);

const reachable = (start: Id, neighbours: (id: Id) => Id[]): Set<Id> => {
  const seen = new Set<Id>();
  const pending = [...neighbours(start)];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...neighbours(id));
  }
  return seen;
};

export const ancestorIds = (graph: BoardGraph, id: Id, ignoreEdgeId?: Id): Set<Id> => {
  const { parents } = adjacencyOf(graph, ignoreEdgeId);
  return reachable(id, (current) => (parents.get(current) ?? []).map((edge) => edge.fromId));
};

export const descendantIds = (graph: BoardGraph, id: Id): Set<Id> => {
  const { children } = adjacencyOf(graph);
  return reachable(id, (current) => (children.get(current) ?? []).map((edge) => edge.toId));
};

export const BRANCH_TITLE_SEPARATOR = " › ";

export const descendantTitlePatches = (graph: BoardGraph, nodeId: Id, newTitle: string): Record<Id, NodePatch> => {
  const oldTitle = graph.nodes[nodeId].title;
  if (oldTitle === newTitle) return {};
  const prefix = `${oldTitle}${BRANCH_TITLE_SEPARATOR}`;
  const patches: Record<Id, NodePatch> = {};
  for (const id of descendantIds(graph, nodeId)) {
    const descendant = graph.nodes[id];
    if (descendant.deleted) continue;
    if (descendant.title === oldTitle) patches[id] = { id, title: newTitle };
    else if (descendant.title.startsWith(prefix)) patches[id] = { id, title: `${newTitle}${BRANCH_TITLE_SEPARATOR}${descendant.title.slice(prefix.length)}` };
  }
  return patches;
};

export const exclusiveDescendantIds = (graph: BoardGraph, rootIds: Id[]): Set<Id> => {
  const { parents } = adjacencyOf(graph);
  const members = new Set(rootIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of liveNodes(graph)) {
      const parentEdges = parents.get(node.id) ?? [];
      if (members.has(node.id) || parentEdges.length === 0) continue;
      if (parentEdges.every((edge) => members.has(edge.fromId))) {
        members.add(node.id);
        grew = true;
      }
    }
  }
  rootIds.forEach((id) => members.delete(id));
  return members;
};

export const hiddenByCollapse = (graph: BoardGraph): Set<Id> => {
  const hidden = new Set<Id>();
  for (const node of liveNodes(graph)) {
    if (node.collapsed) exclusiveDescendantIds(graph, [node.id]).forEach((id) => hidden.add(id));
  }
  return hidden;
};

const IN_FLIGHT_STATUSES: NodeStatus[] = ["queued", "running", "awaiting_approval"];

export const isInFlight = (node: GraphNode): boolean => IN_FLIGHT_STATUSES.includes(node.status);

const lockedCache = new WeakMap<BoardGraph, Set<Id>>();

export const lockedNodeIds = (graph: BoardGraph): Set<Id> => {
  const cached = lockedCache.get(graph);
  if (cached) return cached;
  const locked = new Set<Id>();
  for (const node of liveNodes(graph).filter(isInFlight)) {
    locked.add(node.id);
    ancestorIds(graph, node.id).forEach((id) => locked.add(id));
  }
  lockedCache.set(graph, locked);
  return locked;
};

const LOCKED_REASON = "That node is queued or running, or feeds one that is. Stop the run first";

const refuseLocked = (graph: BoardGraph, ids: Id[]): string | undefined => {
  const locked = lockedNodeIds(graph);
  return ids.some((id) => locked.has(id)) ? LOCKED_REASON : undefined;
};

export const checkEdgeCandidate =(graph: BoardGraph, fromId: Id, toId: Id, ignoreEdgeId?: Id): string | undefined => {
  const from = graph.nodes[fromId];
  const to = graph.nodes[toId];
  if (!from || from.deleted || !to || to.deleted) return "That node no longer exists";
  if (fromId === toId) return "A node cannot feed itself";
  if (from.kind === "subagent") return "A subagent never feeds another node. Its parent already received its result";
  if (to.kind !== "turn" && to.kind !== "code") return "A note or file cannot receive context";
  const duplicate = liveEdges(graph, ignoreEdgeId).some((edge) => edge.fromId === fromId && edge.toId === toId);
  if (duplicate) return "These nodes are already connected";
  if (ancestorIds(graph, fromId, ignoreEdgeId).has(toId)) return "That connection would create a cycle";
  return undefined;
};

const nextSeq = (graph: BoardGraph, toId: Id): number =>
  Math.max(-1, ...incomingEdges(graph, toId).map((edge) => edge.seq)) + 1;

export interface PlacementSize {
  w: number;
  h: number;
}

export interface PlacementAnchor {
  id: Id;
  side: "beside" | "below";
}

export type PlacementFlow = "horizontal" | "vertical";

const PLACEMENT_CLEARANCE = 24;

const overlapsWithClearance = (spot: { x: number; y: number } & PlacementSize, node: GraphNode): boolean =>
  spot.x < node.x + node.w + PLACEMENT_CLEARANCE && node.x < spot.x + spot.w + PLACEMENT_CLEARANCE && spot.y < node.y + node.h + PLACEMENT_CLEARANCE && node.y < spot.y + spot.h + PLACEMENT_CLEARANCE;

const clearOfOtherNodes = (graph: BoardGraph, wanted: { x: number; y: number }, size: PlacementSize): { x: number; y: number } => {
  const others = liveNodes(graph);
  let y = wanted.y;
  for (let blocker = others.find((node) => overlapsWithClearance({ x: wanted.x, y, ...size }, node)); blocker; blocker = others.find((node) => overlapsWithClearance({ x: wanted.x, y, ...size }, node))) {
    y = blocker.y + blocker.h + NODE_ROW_GAP;
  }
  return { x: wanted.x, y };
};

const placeNextToAnchor = (graph: BoardGraph, anchor: PlacementAnchor, size: PlacementSize): { x: number; y: number } | undefined => {
  const origin = graph.nodes[anchor.id];
  if (!origin || origin.deleted) return undefined;
  const wanted = anchor.side === "beside" ? { x: origin.x + origin.w + NODE_GAP, y: origin.y } : { x: origin.x, y: origin.y + origin.h + NODE_ROW_GAP };
  return clearOfOtherNodes(graph, wanted, size);
};

const placeAlongFlow = (graph: BoardGraph, parent: GraphNode, size: PlacementSize, direction: PlacementFlow): { x: number; y: number } => {
  const nodes = liveNodes(graph);
  const isHorizontal = direction === "horizontal";
  const middle = isHorizontal ? { x: parent.x + parent.w + NODE_GAP, y: parent.y } : { x: parent.x, y: parent.y + parent.h + NODE_ROW_GAP };
  const sideGap = isHorizontal ? NODE_ROW_GAP : NODE_GAP;
  const blockerAt = (spot: { x: number; y: number }) => nodes.find((node) => overlapsWithClearance({ ...spot, ...size }, node));
  if (!blockerAt(middle)) return middle;
  const sideOf = (box: { x: number; y: number }) => (isHorizontal ? box.y : box.x);
  const sideSizeOf = (box: PlacementSize) => (isHorizontal ? box.h : box.w);
  const atSide = (side: number) => (isHorizontal ? { x: middle.x, y: side } : { x: side, y: middle.y });
  const slide = (step: 1 | -1) => {
    let spot = middle;
    for (let blocker = blockerAt(spot); blocker; blocker = blockerAt(spot)) {
      spot = atSide(step === 1 ? sideOf(blocker) + sideSizeOf(blocker) + sideGap : sideOf(blocker) - sideSizeOf(size) - sideGap);
    }
    return spot;
  };
  const after = slide(1);
  const before = slide(-1);
  return sideOf(after) - sideOf(middle) <= sideOf(middle) - sideOf(before) ? after : before;
};

export const placeNode = (graph: BoardGraph, parentIds: Id[], size: PlacementSize = { w: NODE_WIDTH, h: NODE_HEIGHT }, anchor?: PlacementAnchor, near?: { x: number; y: number }, flow: PlacementFlow = "horizontal"): { x: number; y: number } => {
  const anchored = anchor && placeNextToAnchor(graph, anchor, size);
  if (anchored) return anchored;
  const parent = graph.nodes[parentIds[0]];
  if (!parent && near) return clearOfOtherNodes(graph, { x: Math.round(near.x - size.w / 2), y: Math.round(near.y - size.h / 2) }, size);
  if (!parent) {
    const nodes = liveNodes(graph);
    if (nodes.length === 0) return { x: 0, y: 0 };
    return { x: Math.max(...nodes.map((node) => node.x + node.w)) + NODE_GAP, y: 0 };
  }
  return placeAlongFlow(graph, parent, size, flow);
};

export const placeSatellite = (graph: BoardGraph, parentId: Id, size: PlacementSize): { x: number; y: number } => {
  const parent = graph.nodes[parentId];
  const siblings = satelliteIdsOf(graph, parentId).map((id) => graph.nodes[id]);
  const y = siblings.length === 0 ? parent.y : Math.max(...siblings.map((node) => node.y + node.h)) + NODE_ROW_GAP;
  return clearOfOtherNodes(graph, { x: parent.x + parent.w + NODE_GAP, y }, size);
};

const nodeFieldPatch = (graph: BoardGraph, ids: Id[], change: (node: GraphNode) => Partial<GraphNode>): Patch => ({
  nodes: indexBy(
    ids.map((id): NodePatch => ({ ...change(graph.nodes[id]), id })),
    (node) => node.id,
  ),
  edges: {},
});

const edgesTouching = (graph: BoardGraph, ids: Set<Id>): GraphEdge[] =>
  Object.values(graph.edges).filter((edge) => !edge.deleted && (ids.has(edge.fromId) || ids.has(edge.toId)));

interface EditKind<E extends GraphEdit> {
  check(graph: BoardGraph, edit: E): string | undefined;
  toPatch(graph: BoardGraph, edit: E): Patch;
}

type EditOf<T extends GraphEdit["type"]> = Extract<GraphEdit, { type: T }>;

const liveEdge = (graph: BoardGraph, edgeId: Id): GraphEdge | undefined => {
  const edge = graph.edges[edgeId];
  return edge && !edge.deleted ? edge : undefined;
};

const liveNode = (graph: BoardGraph, nodeId: Id): GraphNode | undefined => {
  const node = graph.nodes[nodeId];
  return node && !node.deleted ? node : undefined;
};

const connect: EditKind<EditOf<"connect">> = {
  check: (graph, edit) => refuseLocked(graph, [edit.toId]) ?? checkEdgeCandidate(graph, edit.fromId, edit.toId),
  toPatch: (graph, edit) => {
    const edge = makeEdge(graph.nodes[edit.fromId].boardId, edit.fromId, edit.toId, nextSeq(graph, edit.toId));
    return { nodes: {}, edges: { [edge.id]: edge } };
  },
};

const disconnect: EditKind<EditOf<"disconnect">> = {
  check: (graph, edit) => {
    const edge = liveEdge(graph, edit.edgeId);
    return edge ? refuseLocked(graph, [edge.toId]) : "That edge no longer exists";
  },
  toPatch: (_graph, edit) => ({ nodes: {}, edges: { [edit.edgeId]: { id: edit.edgeId, deleted: true } } }),
};

const reattachedEndpoints = (edge: GraphEdge, edit: EditOf<"reattach">) => ({
  fromId: edit.end === "from" ? edit.nodeId : edge.fromId,
  toId: edit.end === "to" ? edit.nodeId : edge.toId,
});

const reattach: EditKind<EditOf<"reattach">> = {
  check: (graph, edit) => {
    const edge = liveEdge(graph, edit.edgeId);
    if (!edge) return "That edge no longer exists";
    const { fromId, toId } = reattachedEndpoints(edge, edit);
    return refuseLocked(graph, [edge.toId, toId]) ?? checkEdgeCandidate(graph, fromId, toId, edit.edgeId);
  },
  toPatch: (graph, edit) => {
    const edge = graph.edges[edit.edgeId];
    const endpoints = reattachedEndpoints(edge, edit);
    const seq = endpoints.toId === edge.toId ? edge.seq : nextSeq(graph, endpoints.toId);
    return { nodes: {}, edges: { [edge.id]: { id: edge.id, ...endpoints, seq } } };
  },
};

const reorderParents: EditKind<EditOf<"reorderParents">> = {
  check: (graph, edit) =>
    refuseLocked(graph, [edit.nodeId]) ??
    (sameMembers(edit.edgeIds, incomingEdges(graph, edit.nodeId).map((edge) => edge.id)) ? undefined : "The incoming edges changed, reorder again"),
  toPatch: (_graph, edit) => ({
    nodes: {},
    edges: indexBy(
      edit.edgeIds.map((edgeId, seq): EdgePatch => ({ id: edgeId, seq })),
      (edge) => edge.id,
    ),
  }),
};

const addNode: EditKind<EditOf<"addNode">> = {
  check: (graph, edit) => {
    if (edit.parentIds.some((id) => !liveNode(graph, id))) return "A parent node no longer exists";
    if (edit.node.kind !== "turn" && edit.node.kind !== "code" && edit.parentIds.length > 0) return "A note or file cannot receive context";
    if (unique(edit.parentIds).length !== edit.parentIds.length) return "Duplicate parents";
    return undefined;
  },
  toPatch: (_graph, edit) => ({
    nodes: { [edit.node.id]: edit.node },
    edges: indexBy(
      edit.parentIds.map((parentId, seq) => makeEdge(edit.node.boardId, parentId, edit.node.id, seq)),
      (edge) => edge.id,
    ),
  }),
};

export const satelliteIdsOf = (graph: BoardGraph, parentId: Id): Id[] =>
  liveNodes(graph)
    .filter((node) => node.satelliteOf === parentId)
    .map((node) => node.id);

const nodesToDelete = (graph: BoardGraph, edit: EditOf<"deleteNodes">): Set<Id> => {
  const ids = new Set(edit.ids);
  if (edit.withExclusiveDescendants) exclusiveDescendantIds(graph, edit.ids).forEach((id) => ids.add(id));
  [...ids].forEach((id) => satelliteIdsOf(graph, id).forEach((satelliteId) => ids.add(satelliteId)));
  return ids;
};

const deleteNodes: EditKind<EditOf<"deleteNodes">> = {
  check: (graph, edit) =>
    edit.ids.length > 0 && edit.ids.every((id) => liveNode(graph, id)) ? refuseLocked(graph, [...nodesToDelete(graph, edit)]) : "Nothing to delete",
  toPatch: (graph, edit) => {
    const ids = nodesToDelete(graph, edit);
    const deletedAt = now();
    return {
      nodes: nodeFieldPatch(graph, [...ids], () => ({ deleted: true, deletedAt })).nodes,
      edges: indexBy(
        edgesTouching(graph, ids).map((edge): EdgePatch => ({ id: edge.id, deleted: true, deletedAt })),
        (edge) => edge.id,
      ),
    };
  },
};

const restoredEdgePatches = (graph: BoardGraph, restoredIds: Set<Id>): Record<Id, EdgePatch> => {
  const deletionTimes = new Set([...restoredIds].map((id) => graph.nodes[id].deletedAt));
  const candidates = Object.values(graph.edges).filter((edge) => edge.deleted && edge.deletedAt !== undefined && deletionTimes.has(edge.deletedAt));
  const restoredNodesPatch: Patch = { nodes: indexBy([...restoredIds].map((id): NodePatch => ({ id, deleted: false })), (node) => node.id), edges: {} };
  let working = applyPatch(graph, restoredNodesPatch);
  const edges: Record<Id, EdgePatch> = {};
  for (const edge of candidates) {
    if (checkEdgeCandidate(working, edge.fromId, edge.toId) !== undefined) continue;
    const change: EdgePatch = { id: edge.id, deleted: false, deletedAt: undefined, seq: nextSeq(working, edge.toId) };
    edges[edge.id] = change;
    working = applyPatch(working, { nodes: {}, edges: { [edge.id]: change } });
  }
  return edges;
};

const restoreNodes: EditKind<EditOf<"restoreNodes">> = {
  check: (graph, edit) => (edit.ids.length > 0 && edit.ids.every((id) => graph.nodes[id]?.deleted) ? undefined : "Nothing to restore"),
  toPatch: (graph, edit) => ({
    nodes: nodeFieldPatch(graph, edit.ids, () => ({ deleted: false, deletedAt: undefined })).nodes,
    edges: restoredEdgePatches(graph, new Set(edit.ids)),
  }),
};

const moveNodes: EditKind<EditOf<"moveNodes">> = {
  check: (graph, edit) => (Object.keys(edit.positions).every((id) => liveNode(graph, id)) ? undefined : "A node no longer exists"),
  toPatch: (graph, edit) =>
    nodeFieldPatch(
      graph,
      Object.keys(edit.positions).filter((id) => !graph.nodes[id].pinned),
      (node) => edit.positions[node.id],
    ),
};

const pin: EditKind<EditOf<"pin">> = {
  check: (graph, edit) => (liveNode(graph, edit.nodeId) ? undefined : "That node no longer exists"),
  toPatch: (graph, edit) => nodeFieldPatch(graph, [edit.nodeId], (node) => ({ pinned: edit.pinned ?? !node.pinned })),
};

const setSummary: EditKind<EditOf<"setSummary">> = {
  check: (graph, edit) => (liveNode(graph, edit.nodeId) ? undefined : "That node no longer exists"),
  toPatch: (graph, edit) =>
    nodeFieldPatch(graph, [edit.nodeId], () => ({ summary: edit.summary ?? { text: "", coveredNodeIds: [], contextHash: "", rev: 0, tokens: 0 } })),
};

const isPromptEditable = (node: GraphNode): boolean => node.kind !== "turn" || node.status === "idle";

const editNode: EditKind<EditOf<"editNode">> = {
  check: (graph, edit) => {
    const node = liveNode(graph, edit.nodeId);
    if (!node) return "That node no longer exists";
    const touchesRunFields = ["prompt", "forceAssemble", ...RUN_CHOICE_KEYS].some((key) => key in edit.fields);
    if (!touchesRunFields) return undefined;
    if (!isPromptEditable(node)) return "A finished node cannot change. Use Edit to reopen it";
    return refuseLocked(graph, [node.id]);
  },
  toPatch: (graph, edit) => {
    const own = nodeFieldPatch(graph, [edit.nodeId], (node) => ({
      ...edit.fields,
      ...("prompt" in edit.fields && edit.fields.prompt !== node.prompt ? rollPatchForDiscard(node) : {}),
      rev: "prompt" in edit.fields ? node.rev + 1 : node.rev,
    }));
    if (typeof edit.fields.title !== "string") return own;
    return { ...own, nodes: { ...own.nodes, ...descendantTitlePatches(graph, edit.nodeId, edit.fields.title) } };
  },
};

const editableAttachmentNode = (graph: BoardGraph, nodeId: Id): string | undefined => {
  const node = liveNode(graph, nodeId);
  if (!node) return "That node no longer exists";
  if (node.kind === "context" || node.kind === "code") return "A note or code node cannot hold attachments";
  if (!isPromptEditable(node)) return "Click Edit on a finished node before changing its attachments";
  return refuseLocked(graph, [nodeId]);
};

const attach: EditKind<EditOf<"attach">> = {
  check: (graph, edit) => editableAttachmentNode(graph, edit.nodeId) ?? (edit.attachments.length > 0 ? undefined : "Nothing to attach"),
  toPatch: (graph, edit) =>
    nodeFieldPatch(graph, [edit.nodeId], (node) => ({ attachments: [...(node.attachments ?? []), ...edit.attachments], rev: node.rev + 1, ...rollPatchForDiscard(node) })),
};

const detach: EditKind<EditOf<"detach">> = {
  check: (graph, edit) => editableAttachmentNode(graph, edit.nodeId),
  toPatch: (graph, edit) =>
    nodeFieldPatch(graph, [edit.nodeId], (node) => ({ attachments: (node.attachments ?? []).filter((item) => item.id !== edit.attachmentId), rev: node.rev + 1, ...rollPatchForDiscard(node) })),
};

const REOPENABLE_STATUSES: NodeStatus[] = ["done", "error", "interrupted"];

const reopen: EditKind<EditOf<"reopen">> = {
  check: (graph, edit) => {
    const node = liveNode(graph, edit.nodeId);
    if (!node || node.kind !== "turn" || !REOPENABLE_STATUSES.includes(node.status)) return "Only a finished chat can be edited";
    return refuseLocked(graph, [node.id]);
  },
  toPatch: (graph, edit) => nodeFieldPatch(graph, [edit.nodeId], () => ({ status: "idle", stopped: false, startedAt: undefined, completedAt: undefined })),
};

const QUEUEABLE_STATUSES: NodeStatus[] = ["idle", ...REOPENABLE_STATUSES];

const queue: EditKind<EditOf<"queue">> = {
  check: (graph, edit) => {
    const node = liveNode(graph, edit.nodeId);
    if (!node || node.kind !== "turn" || !QUEUEABLE_STATUSES.includes(node.status)) return "Only an idle or finished chat can run";
    if (!node.prompt.trim()) return "Write a prompt first";
    return refuseLocked(graph, [...descendantIds(graph, node.id)]);
  },
  toPatch: (graph, edit) => nodeFieldPatch(graph, [edit.nodeId], rollPatchForQueue),
};

const selectRoll: EditKind<EditOf<"selectRoll">> = {
  check: (graph, edit) => {
    const node = liveNode(graph, edit.nodeId);
    if (!node || node.kind !== "turn" || !REOPENABLE_STATUSES.includes(node.status)) return "Only a finished chat has rolls to switch between";
    if (!canSelectRoll(node, edit.roll)) return "That roll no longer exists";
    return refuseLocked(graph, [node.id]);
  },
  toPatch: (graph, edit) => nodeFieldPatch(graph, [edit.nodeId], (node) => rollPatchForSelect(node, edit.roll)),
};

const collapse: EditKind<EditOf<"collapse">> = {
  check: (graph, edit) => (liveNode(graph, edit.nodeId) ? undefined : "That node no longer exists"),
  toPatch: (graph, edit) => nodeFieldPatch(graph, [edit.nodeId], (node) => ({ collapsed: edit.collapsed ?? !node.collapsed })),
};

const patch: EditKind<EditOf<"patch">> = {
  check: () => undefined,
  toPatch: (_graph, edit) => edit.patch,
};

export const editKinds: { [T in GraphEdit["type"]]: EditKind<EditOf<T>> } = {
  connect,
  disconnect,
  reattach,
  reorderParents,
  addNode,
  deleteNodes,
  moveNodes,
  attach,
  detach,
  reopen,
  queue,
  selectRoll,
  editNode,
  collapse,
  pin,
  restoreNodes,
  setSummary,
  patch,
};

const mergeEntities = <T extends { id: Id }>(current: Record<Id, T>, changes: Record<Id, Partial<T> & { id: Id }>): Record<Id, T> => {
  const merged = { ...current };
  for (const [id, change] of Object.entries(changes)) merged[id] = { ...merged[id], ...change } as T;
  return merged;
};

export const applyPatch = (graph: BoardGraph, change: Patch): BoardGraph => ({
  nodes: mergeEntities(graph.nodes, change.nodes),
  edges: mergeEntities(graph.edges, change.edges),
});

const invertEntities = <T extends { id: Id }>(current: Record<Id, T>, changes: Record<Id, Partial<T> & { id: Id }>): Record<Id, Partial<T> & { id: Id }> =>
  mapValues(changes, (change, id) => {
    const before = current[id];
    if (!before) return { id, deleted: true } as unknown as Partial<T> & { id: Id };
    return Object.fromEntries(Object.keys(change).map((key) => [key, before[key as keyof T]])) as Partial<T> & { id: Id };
  });

export const invertPatch = (graph: BoardGraph, change: Patch): Patch => ({
  nodes: invertEntities(graph.nodes, change.nodes),
  edges: invertEntities(graph.edges, change.edges),
});

export interface AppliedEdit {
  graph: BoardGraph;
  patch: Patch;
  inverse: Patch;
}

export const runEdit = (graph: BoardGraph, edit: GraphEdit): AppliedEdit | Refusal => {
  const kind = editKinds[edit.type] as EditKind<GraphEdit> | undefined;
  if (!kind) return refuse(`Unknown edit ${String((edit as { type: string }).type)}`);
  const reason = kind.check(graph, edit);
  if (reason) return refuse(reason);
  const change = kind.toPatch(graph, edit);
  return { graph: applyPatch(graph, change), patch: change, inverse: invertPatch(graph, change) };
};

export const checkEdit = (graph: BoardGraph, edit: GraphEdit): string | undefined => {
  const result = runEdit(graph, edit);
  return isRefusal(result) ? result.refusal : undefined;
};
