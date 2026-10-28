import {
  activeRollOf,
  applyRunEvent,
  attachmentIdsOf,
  collectBoard,
  emptyGraph,
  indexBy,
  isInFlight,
  isRefusal,
  liveNodes,
  lockedNodeIds,
  newId,
  now,
  runEdit,
  sessionReferencesOf,
  withoutLongToolOutputs,
  type Board,
  type BoardGraph,
  type BoardSnapshot,
  type GraphEdit,
  type GraphNode,
  type Id,
  type Part,
  type Patch,
  type PendingRequest,
  type Project,
  type RunEvent,
  type RuntimeRef,
} from "@branchboard/core";
import { basename } from "node:path";
import type { Hub } from "./hub";
import type { Repository } from "./db";
import type { UsageRecorder } from "./usage";

export class RefusedError extends Error {}

export class SensitiveFilesError extends RefusedError {
  constructor(readonly files: string[]) {
    super(`Confirmation needed before using: ${files.join(", ")}`);
  }
}

export interface BoardState {
  board: Board;
  graph: BoardGraph;
  parts: Record<Id, Part[]>;
  requests: Record<Id, PendingRequest>;
  undoStack: Patch[];
  redoStack: Patch[];
}

const PART_FLUSH_MS = 250;

const orphanedSessions = (before: RuntimeRef[], after: RuntimeRef[]): RuntimeRef[] => {
  const kept = new Set(after.map((reference) => reference.sessionId));
  return before.filter((reference) => !kept.has(reference.sessionId));
};

const sessionIdsInPatch = (patch: Patch): string[] => sessionReferencesOf(Object.values(patch.nodes) as GraphNode[]).map((reference) => reference.sessionId);

export const createBoardService = (repository: Repository, hub: Hub, usage?: UsageRecorder) => {
  const states = new Map<Id, BoardState>();
  const flushTimers = new Map<Id, NodeJS.Timeout>();
  let hasStoppedSaving = false;
  const viewJsons = new Map<Id, string>();

  const invalidateView = (boardId: Id) => void viewJsons.delete(boardId);

  const readState = (boardId: Id): BoardState | undefined => {
    const board = repository.get<Board>("boards", boardId);
    if (!board || board.deleted) return undefined;
    const nodes = repository.list<BoardGraph["nodes"][Id]>("nodes", boardId);
    const edges = repository.list<BoardGraph["edges"][Id]>("edges", boardId);
    const parts: Record<Id, Part[]> = {};
    repository.list<Part>("parts", boardId).forEach((part) => (parts[part.nodeId] ??= []).push(part));
    Object.values(parts).forEach((list) => list.sort((left, right) => left.seq - right.seq));
    const requests = indexBy(repository.list<PendingRequest>("requests", boardId), (request) => request.id);
    return { board, graph: { nodes: indexBy(nodes, (node) => node.id), edges: indexBy(edges, (edge) => edge.id) }, parts, requests, undoStack: [], redoStack: [] };
  };

  const stateOf = (boardId: Id): BoardState => {
    const cached = states.get(boardId);
    if (cached) return cached;
    const loaded = readState(boardId);
    if (!loaded) throw new RefusedError("Board not found");
    states.set(boardId, loaded);
    return loaded;
  };

  const persistGraph = (state: BoardState, graph: BoardGraph, patch: Patch) => {
    const boardId = state.board.id;
    invalidateView(boardId);
    repository.upsertMany("nodes", () => boardId, Object.keys(patch.nodes).map((id) => graph.nodes[id]));
    repository.upsertMany("edges", () => boardId, Object.keys(patch.edges).map((id) => graph.edges[id]));
  };

  const saveBoard = (board: Board) => {
    repository.upsertMany("boards", (row) => row.id, [board]);
    invalidateView(board.id);
    const cached = states.get(board.id);
    if (cached) cached.board = board;
  };

  const markSaved = (boardId: Id) => {
    const at = now();
    saveBoard({ ...stateOf(boardId).board, updatedAt: at });
    hub.broadcast(boardId, { type: "saved", at });
  };

  const commitPatch = (boardId: Id, edit: GraphEdit, record: boolean): Patch => {
    const state = stateOf(boardId);
    const result = runEdit(state.graph, edit);
    if (isRefusal(result)) throw new RefusedError(result.refusal);
    const touchedNodes = (graph: BoardGraph) => Object.keys(result.patch.nodes).flatMap((id) => graph.nodes[id] ?? []);
    const orphans = record ? orphanedSessions(sessionReferencesOf(touchedNodes(state.graph)), sessionReferencesOf(touchedNodes(result.graph))) : [];
    persistGraph(state, result.graph, result.patch);
    state.graph = result.graph;
    if (orphans.length > 0) saveBoard({ ...state.board, discardedSessions: [...(state.board.discardedSessions ?? []), ...orphans] });
    markSaved(boardId);
    if (record) {
      state.undoStack.push(result.inverse);
      state.redoStack = [];
    }
    hub.broadcast(boardId, { type: "patch", patch: result.patch });
    return result.patch;
  };

  const travel = (boardId: Id, from: "undoStack" | "redoStack", to: "undoStack" | "redoStack"): Patch | undefined => {
    const state = stateOf(boardId);
    const patch = state[from].at(-1);
    if (!patch) return undefined;
    const locked = lockedNodeIds(state.graph);
    const touchedIds = [...Object.keys(patch.nodes), ...Object.keys(patch.edges).flatMap((id) => [state.graph.edges[id]?.toId ?? "", patch.edges[id].toId ?? ""])];
    if (touchedIds.some((id) => locked.has(id))) throw new RefusedError("Undo would change a node that is queued or running, or feeds one. Stop the run first");
    const result = runEdit(state.graph, { type: "patch", patch });
    if (isRefusal(result)) throw new RefusedError(result.refusal);
    persistGraph(state, result.graph, result.patch);
    state[from].pop();
    state.graph = result.graph;
    markSaved(boardId);
    state[to].push(result.inverse);
    hub.broadcast(boardId, { type: "patch", patch: result.patch });
    return result.patch;
  };

  const flushParts = (boardId: Id, nodeId: Id) => {
    clearTimeout(flushTimers.get(nodeId));
    flushTimers.delete(nodeId);
    const parts = states.get(boardId)?.parts[nodeId];
    if (!parts || hasStoppedSaving) return;
    repository.upsertMany("parts", () => boardId, parts);
    markSaved(boardId);
  };

  const scheduleFlush = (boardId: Id, nodeId: Id) => {
    if (!hasStoppedSaving && !flushTimers.has(nodeId)) flushTimers.set(nodeId, setTimeout(() => flushParts(boardId, nodeId), PART_FLUSH_MS));
  };

  const recordRunEvent = (boardId: Id, nodeId: Id, event: RunEvent) => {
    const state = stateOf(boardId);
    state.parts[nodeId] = applyRunEvent(state.parts[nodeId] ?? [], nodeId, activeRollOf(state.graph.nodes[nodeId]), event);
    invalidateView(boardId);
    scheduleFlush(boardId, nodeId);
    hub.broadcast(boardId, { type: "run", nodeId, event });
  };

  const saveRequest = (request: PendingRequest) => {
    const state = stateOf(request.boardId);
    state.requests[request.id] = request;
    invalidateView(request.boardId);
    repository.upsertMany("requests", () => request.boardId, [request]);
    hub.broadcast(request.boardId, { type: "request", request });
  };

  const saveSnapshot = ({ board, graph, parts }: BoardSnapshot) => {
    repository.upsertMany("boards", (row) => row.id, [board]);
    repository.upsertMany("nodes", () => board.id, Object.values(graph.nodes));
    repository.upsertMany("edges", () => board.id, Object.values(graph.edges));
    repository.upsertMany("parts", () => board.id, Object.values(parts).flat());
  };

  const recoverInterruptedRuns = () => {
    for (const board of repository.listAll<Board>("boards")) {
      if (board.deleted) {
        repository.upsertMany("nodes", () => board.id, repository.list<GraphNode>("nodes", board.id).filter(isInFlight).map((node) => ({ ...node, status: "interrupted" as const })));
        repository.upsertMany("requests", () => board.id, repository.list<PendingRequest>("requests", board.id).filter((request) => request.status === "open").map((request) => ({ ...request, status: "closed" as const, answer: "interrupted" })));
        continue;
      }
      const state = stateOf(board.id);
      const interrupted = liveNodes(state.graph).filter(isInFlight);
      interrupted.forEach((node) => {
        commitPatch(board.id, { type: "patch", patch: { nodes: { [node.id]: { id: node.id, status: "interrupted" } }, edges: {} } }, false);
        usage?.record({ type: "run", boardId: board.id, outcome: "interrupted", stopped: false, runtime: board.mode, contextMode: node.contextMode, isRegeneration: activeRollOf(node) > 1 });
      });
      Object.values(state.requests)
        .filter((request) => request.status === "open")
        .forEach((request) => saveRequest({ ...request, status: "closed", answer: "interrupted" }));
    }
  };

  const saveNow = (boardId: Id) => {
    const state = stateOf(boardId);
    Object.keys(state.parts).forEach((nodeId) => flushParts(boardId, nodeId));
    repository.upsertMany("nodes", () => boardId, Object.values(state.graph.nodes));
    repository.upsertMany("edges", () => boardId, Object.values(state.graph.edges));
    repository.upsertMany("requests", () => boardId, Object.values(state.requests));
    repository.checkpoint();
    markSaved(boardId);
    return { savedAt: stateOf(boardId).board.updatedAt };
  };

  const announceBoard = (boardId: Id) => hub.broadcast(boardId, { type: "board", board: stateOf(boardId).board });

  const listProjects = () =>
    repository
      .listAll<Project>("projects")
      .filter((project) => !project.deleted)
      .sort((left, right) => left.createdAt - right.createdAt);

  const saveProject = (project: Project) => repository.upsertMany("projects", (row) => row.id, [project]);

  const findOrCreateProject = (details: Pick<Project, "workspacePath" | "mode"> & Partial<Project>): Project => {
    const existing = listProjects().find((project) => project.workspacePath === details.workspacePath && project.mode === details.mode);
    if (existing) return existing;
    const project: Project = {
      id: newId(),
      name: details.name || basename(details.workspacePath) || details.workspacePath,
      workspacePath: details.workspacePath,
      mode: details.mode,
      defaultAgent: details.defaultAgent,
      defaultModel: details.defaultModel,
      createdAt: now(),
      updatedAt: now(),
      deleted: false,
    };
    saveProject(project);
    return project;
  };

  const adoptLegacyBoards = () => {
    for (const board of repository.listAll<Board>("boards")) {
      if (board.projectId) continue;
      const project = findOrCreateProject({ workspacePath: board.workspacePath, mode: board.mode, defaultAgent: board.defaultAgent, defaultModel: board.defaultModel });
      repository.upsertMany("boards", (row) => row.id, [{ ...board, projectId: project.id }]);
    }
  };

  adoptLegacyBoards();

  const attachmentIdsInPatch = (patch: Patch): string[] => attachmentIdsOf(Object.values(patch.nodes) as GraphNode[]);

  const referencedAttachmentIds = (): Set<string> => {
    const stored = attachmentIdsOf(repository.listAll<GraphNode>("nodes"));
    const pending = [...states.values()].flatMap((state) => [...state.undoStack, ...state.redoStack]).flatMap(attachmentIdsInPatch);
    return new Set([...stored, ...pending]);
  };

  const dropHistoryOf = (boardId: Id, nodeId: Id) => {
    const state = stateOf(boardId);
    const untouched = (patch: Patch) => !(nodeId in patch.nodes);
    state.undoStack = state.undoStack.filter(untouched);
    state.redoStack = state.redoStack.filter(untouched);
  };

  const sessionIdsHeldByHistory = (): Set<string> =>
    new Set([...states.values()].flatMap((state) => [...state.undoStack, ...state.redoStack]).flatMap(sessionIdsInPatch));

  const viewJsonOf = (boardId: Id): string => {
    let json = viewJsons.get(boardId);
    if (!json) {
      const { board, graph, parts, requests } = stateOf(boardId);
      json = JSON.stringify({ board, graph, parts: withoutLongToolOutputs(parts), requests, savedAt: board.updatedAt });
      viewJsons.set(boardId, json);
    }
    return `${json.slice(0, -1)},"seq":${hub.seqOf(boardId)}}`;
  };

  const toolOutputOf = (boardId: Id, nodeId: Id, partId: Id): unknown => stateOf(boardId).parts[nodeId]?.find((part) => part.id === partId)?.meta?.output;

  const storedToolOutputOf = (part: Part): unknown => {
    const stored = repository.get<Part>("parts", part.id);
    return stored?.nodeId === part.nodeId ? stored.meta?.output : undefined;
  };

  return {
    forget: (boardId: Id) => {
      states.delete(boardId);
      invalidateView(boardId);
    },
    invalidateView,
    viewJsonOf,
    toolOutputOf,
    storedToolOutputOf,
    referencedAttachmentIds,
    dropHistoryOf,
    sessionIdsHeldByHistory,
    loadedBoardIds: () => [...states.keys()],
    saveNow,
    announceBoard,
    listProjects,
    saveProject,
    findOrCreateProject,
    stateOf,
    commitEdit: (boardId: Id, edit: GraphEdit) => {
      const patch = commitPatch(boardId, edit, true);
      usage?.record({ type: "edit", boardId });
      return patch;
    },
    commitRunPatch: (boardId: Id, edit: GraphEdit) => commitPatch(boardId, edit, false),
    undo: (boardId: Id) => travel(boardId, "undoStack", "redoStack"),
    redo: (boardId: Id) => travel(boardId, "redoStack", "undoStack"),
    recordRunEvent,
    flushParts,
    flushPartsAndStopSaving: () => {
      states.forEach((state, boardId) => Object.keys(state.parts).forEach((nodeId) => flushParts(boardId, nodeId)));
      hasStoppedSaving = true;
    },
    saveRequest,
    saveBoard,
    saveSnapshot,
    recoverInterruptedRuns,
    listBoards: () => repository.listAll<Board>("boards").filter((board) => !board.deleted).sort((left, right) => right.updatedAt - left.updatedAt),
    createBoard: (board: Board) => {
      saveSnapshot({ board, graph: emptyGraph(), parts: {} });
      return board;
    },
    exportDocument: (boardId: Id) => {
      const state = stateOf(boardId);
      Object.keys(state.parts).forEach((nodeId) => flushParts(boardId, nodeId));
      return collectBoard(state);
    },
    openRequests: (boardId: Id) => Object.values(stateOf(boardId).requests).filter((request) => request.status === "open"),
  };
};

export type BoardService = ReturnType<typeof createBoardService>;
