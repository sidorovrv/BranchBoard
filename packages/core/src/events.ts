import { applyPatch } from "./graph";
import { activeRollOf } from "./rolls";
import type { BoardEvent, BoardView, Id, Part, RunEvent } from "./types";

export const partIdFor = (nodeId: Id, roll: number, partKey: string): string => `${nodeId}:${roll}:${partKey}`;

const upsertPart = (parts: Part[], nodeId: Id, roll: number, partKey: string, create: () => Omit<Part, "id" | "nodeId" | "roll" | "seq">, update: (part: Part) => Part): Part[] => {
  const id = partIdFor(nodeId, roll, partKey);
  const existing = parts.find((part) => part.id === id);
  if (existing) return parts.map((part) => (part === existing ? update(part) : part));
  return [...parts, { id, nodeId, roll, seq: parts.length, ...create() }];
};

type RunReducer<E extends RunEvent> = (parts: Part[], nodeId: Id, roll: number, event: E) => Part[];

const keepParts: RunReducer<RunEvent> = (parts) => parts;

const withoutRetryNotice: RunReducer<RunEvent> = (parts, nodeId, roll) => parts.filter((part) => part.id !== partIdFor(nodeId, roll, RETRY_PART_KEY));

const RETRY_PART_KEY = "retry";

const runReducers: { [T in RunEvent["type"]]: RunReducer<Extract<RunEvent, { type: T }>> } = {
  "part.delta": (parts, nodeId, roll, event) =>
    upsertPart(
      event.partType === "text" ? withoutRetryNotice(parts, nodeId, roll, event) : parts,
      nodeId,
      roll,
      event.partKey,
      () => ({ type: event.partType, text: event.text }),
      (part) => ({ ...part, text: part.text + event.text }),
    ),
  retry: (parts, nodeId, roll, event) =>
    upsertPart(
      parts,
      nodeId,
      roll,
      RETRY_PART_KEY,
      () => ({ type: "retry", text: event.reason, meta: { attempt: event.attempt, at: event.at } }),
      (part) => ({ ...part, text: event.reason, meta: { attempt: event.attempt, at: event.at } }),
    ),
  "retry-restart": (parts, nodeId, roll, event) => {
    const dropped = new Set(event.partKeys.map((key) => partIdFor(nodeId, roll, key)));
    return parts.filter((part) => !dropped.has(part.id));
  },
  "tool.started": (parts, nodeId, roll, event) =>
    upsertPart(
      parts,
      nodeId,
      roll,
      event.partKey,
      () => ({ type: "tool", text: event.description, meta: { tool: event.tool, input: event.input, status: "running" } }),
      (part) => part,
    ),
  "tool.done": (parts, nodeId, roll, event) =>
    parts.map((part) =>
      part.id === partIdFor(nodeId, roll, event.partKey)
        ? { ...part, meta: { ...part.meta, status: event.isError ? "error" : "done", output: event.output } }
        : part,
    ),
  error: (parts, nodeId, roll, event) =>
    upsertPart(withoutRetryNotice(parts, nodeId, roll, event), nodeId, roll, `error:${parts.length}`, () => ({ type: "error", text: event.message, ...(event.recovery ? { meta: { recovery: event.recovery } } : {}) }), (part) => part),
  todos: (parts, nodeId, roll, event) =>
    upsertPart(
      parts,
      nodeId,
      roll,
      "todos",
      () => ({ type: "todo", text: "", meta: { items: event.items } }),
      (part) => ({ ...part, meta: { items: event.items } }),
    ),
  "subagent.started": keepParts,
  prompt: keepParts,
  "subagent.event": keepParts,
  "request.opened": keepParts,
  usage: keepParts,
  "context.compacted": keepParts,
  done: withoutRetryNotice,
};

export const withPartKeyPrefix = (event: RunEvent, prefix: string): RunEvent => {
  if (event.type === "part.delta" || event.type === "tool.started" || event.type === "tool.done") return { ...event, partKey: `${prefix}${event.partKey}` };
  if (event.type === "retry-restart") return { ...event, partKeys: event.partKeys.map((key) => `${prefix}${key}`) };
  return event;
};

export const applyRunEvent =(parts: Part[], nodeId: Id, roll: number, event: RunEvent): Part[] =>
  (runReducers[event.type] as RunReducer<RunEvent>)(parts, nodeId, roll, event);

const activeRollInView = (view: BoardView, nodeId: Id): number => {
  const node = view.graph.nodes[nodeId];
  return node ? activeRollOf(node) : 1;
};

type ViewReducer<E extends BoardEvent> = (view: BoardView, event: E) => BoardView;

const viewReducers: { [T in BoardEvent["type"]]: ViewReducer<Extract<BoardEvent, { type: T }>> } = {
  patch: (view, event) => ({ ...view, graph: applyPatch(view.graph, event.patch) }),
  run: (view, event) => ({ ...view, parts: { ...view.parts, [event.nodeId]: applyRunEvent(view.parts[event.nodeId] ?? [], event.nodeId, activeRollInView(view, event.nodeId), event.event) } }),
  request: (view, event) => ({ ...view, requests: { ...view.requests, [event.request.id]: event.request } }),
  board: (view) => view,
  saved: (view, event) => ({ ...view, savedAt: event.at }),
};

export const applyBoardEvent = (view: BoardView, event: BoardEvent): BoardView =>
  (viewReducers[event.type] as ViewReducer<BoardEvent>)(view, event);

export const emptyView = (): BoardView => ({ graph: { nodes: {}, edges: {} }, parts: {}, requests: {}, savedAt: 0 });
