import type { Attachment, Board, BoardEvent, BoardView, Catalog, CostSummary, Project, RateLimits, RunInfo, TrashListing } from "@branchboard/core";

export class CommandRefused extends Error {
  constructor(message: string, readonly sensitiveFiles: string[] = []) {
    super(message);
  }
}

const readJson = async (response: Response) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new CommandRefused(body.error ?? `Request failed (${response.status})`, Array.isArray(body.sensitiveFiles) ? body.sensitiveFiles.map(String) : []);
  return body;
};

export const sendCommand = async <T = any>(command: Record<string, unknown>): Promise<T> =>
  readJson(await fetch("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) }));

export const getJson = async <T = any>(path: string): Promise<T> => readJson(await fetch(path));

export const pickFolder = async (): Promise<string | null> =>
  (await readJson(await fetch("/api/pick-folder", { method: "POST" }))).path;

export const uploadAttachment = async (boardId: string, file: File): Promise<Attachment> =>
  readJson(
    await fetch(`/api/boards/${boardId}/attachments?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }),
  );

export const attachmentUrl = (attachmentId: string): string => `/api/attachments/${attachmentId}`;

export const fetchBoards = () => getJson<Board[]>("/api/boards");

export const fetchRuns = () => getJson<RunInfo[]>("/api/runs");

export const fetchFinishedRuns = () => getJson<RunInfo[]>("/api/runs/finished");

export const fetchLimits = () => getJson<RateLimits | null>("/api/limits");

export const fetchCosts = () => getJson<CostSummary>("/api/costs");

export const fetchProjects =() => getJson<Project[]>("/api/projects");

export const fetchTrash = () => getJson<TrashListing>("/api/trash");

export interface RuntimeHealth {
  id: string;
  workspacePath: string;
  isOk: boolean;
  detail: string;
  executable?: string;
  authMethod?: string;
  isSignedIn?: boolean;
  processSlots?: { active: number; limit: number; waiting: number };
  servers?: string[];
  supportsSubagentText?: boolean;
}

export const fetchHealth = () => getJson<{ runtimes: RuntimeHealth[]; logFile: string | null }>("/api/health");

export const fetchLogs = (filter?: string) => getJson<{ lines: string[] }>(`/api/logs?tail=400${filter ? `&filter=${encodeURIComponent(filter)}` : ""}`);

export const fetchWorkspaceFiles = (boardId: string, query: string) => getJson<string[]>(`/api/workspace/files?board=${boardId}&q=${encodeURIComponent(query)}`);

export const fetchBoardView = (boardId: string) => getJson<BoardView & { board: Board }>(`/api/boards/${boardId}/graph`);

export const fetchCatalog = (boardId: string) => getJson<Catalog>(`/api/runtime/catalog?board=${boardId}`);

const RECONNECT_DELAY_MS = 1000;

export const subscribeToBoard = (boardId: string, onEvent: (event: BoardEvent) => void, onReconnect: () => void): (() => void) => {
  let socket: WebSocket | undefined;
  let closed = false;
  let hasConnectedBefore = false;
  const connect = () => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${scheme}://${location.host}/api/events?board=${boardId}`);
    socket.onopen = () => {
      if (hasConnectedBefore) onReconnect();
      hasConnectedBefore = true;
    };
    socket.onmessage = (message) => onEvent(JSON.parse(message.data));
    socket.onclose = () => !closed && setTimeout(connect, RECONNECT_DELAY_MS);
  };
  connect();
  return () => {
    closed = true;
    socket?.close();
  };
};

export const workspaceFileUrl = (boardId: string, path: string, hash = ""): string => `/api/boards/${boardId}/files?path=${encodeURIComponent(path)}${hash}`;
