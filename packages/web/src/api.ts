import { COMMAND_TYPE_HEADER, type AboutInfo, type Attachment, type Board, type BoardEvent, type BoardView, type Catalog, type CostSummary, type CredentialStatus, type Project, type RateLimits, type RunInfo, type RuntimePanel, type TelemetryOverview, type TrashListing } from "@branchboard/core";

export class CommandRefused extends Error {
  constructor(message: string, readonly sensitiveFiles: string[] = []) {
    super(message);
  }
}

const checkedBody = (response: Response, body: any) => {
  if (!response.ok) throw new CommandRefused(body.error ?? `Request failed (${response.status})`, Array.isArray(body.sensitiveFiles) ? body.sensitiveFiles.map(String) : []);
  return body;
};

const readJson = async (response: Response) => checkedBody(response, await response.json().catch(() => ({})));

const getTimedJson = async <T = any>(path: string): Promise<{ body: T; fetchMs: number; parseMs: number }> => {
  const startedAt = performance.now();
  const response = await fetch(path);
  const text = await response.text();
  const fetchedAt = performance.now();
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const body = checkedBody(response, parsed);
  return { body, fetchMs: fetchedAt - startedAt, parseMs: performance.now() - fetchedAt };
};

export const sendCommand = async <T = any>(command: Record<string, unknown>): Promise<T> =>
  readJson(
    await fetch("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json", [COMMAND_TYPE_HEADER]: String(command.type) },
      body: JSON.stringify(command),
    }),
  );

export const getJson = async <T = any>(path: string): Promise<T> => readJson(await fetch(path));

export const downloadFromApi = async (path: string, fileName: string): Promise<void> => {
  const response = await fetch(path);
  if (!response.ok) throw new CommandRefused((await response.json().catch(() => ({}))).error ?? `Request failed (${response.status})`);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await response.blob());
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
};

export interface BrowsedFolder {
  path: string;
  parent: string | null;
  entries: { name: string; isFolder: boolean }[];
}

export const pickPath = async (kind: "folder" | "file", boardId?: string): Promise<string | null> =>
  (await readJson(await fetch(`/api/pick-path?kind=${kind}${boardId ? `&board=${boardId}` : ""}`, { method: "POST" }))).path;

export const browseFolder = (path: string | undefined, includeFiles: boolean) =>
  getJson<BrowsedFolder>(`/api/browse?files=${includeFiles ? 1 : 0}${path ? `&path=${encodeURIComponent(path)}` : ""}`);

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

export const fetchLimits = (runtime: string) => getJson<RateLimits | null>(`/api/limits?runtime=${encodeURIComponent(runtime)}`);

export const fetchCosts = () => getJson<CostSummary>("/api/costs");

export const fetchProjects = () => getJson<Project[]>("/api/projects");

export const fetchTrash = () => getJson<TrashListing>("/api/trash");


export const fetchRuntimeCatalog = (mode: string, isFresh = false) => getJson<Catalog>(`/api/runtime/catalog?mode=${encodeURIComponent(mode)}${isFresh ? "&fresh=1" : ""}`);

export const fetchCredentialStatus = (mode: string) => getJson<CredentialStatus>(`/api/runtime/credential?mode=${encodeURIComponent(mode)}`);

export const fetchAbout =(isFresh = false) => getJson<AboutInfo>(`/api/about${isFresh ? "?fresh=1" : ""}`);


export const fetchWorkspaceFiles = (boardId: string, query: string) => getJson<string[]>(`/api/workspace/files?board=${boardId}&q=${encodeURIComponent(query)}`);

export const fetchTimedBoardView = (boardId: string) => getTimedJson<BoardView & { board: Board }>(`/api/boards/${boardId}/graph`);

export const fetchBoardView = async (boardId: string) => (await fetchTimedBoardView(boardId)).body;

export const fetchToolOutput = async (boardId: string, nodeId: string, partId: string): Promise<string> =>
  (await getJson<{ output: string }>(`/api/boards/${boardId}/tool-output?node=${encodeURIComponent(nodeId)}&part=${encodeURIComponent(partId)}`)).output;

export const fetchCatalog =(boardId: string) => getJson<Catalog>(`/api/runtime/catalog?board=${boardId}`);

const RECONNECT_DELAY_MS = 1000;

export const subscribeToBoard = (boardId: string, onEvent: (event: BoardEvent) => void, onOpen: () => void): (() => void) => {
  let socket: WebSocket | undefined;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (closed) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${scheme}://${location.host}/api/events?board=${boardId}`);
    socket.onopen = onOpen;
    socket.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    };
    socket.onclose = () => (reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS));
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(reconnectTimer);
    socket?.close();
  };
};

export const workspaceFileUrl = (boardId: string, path: string, hash = ""): string => `/api/boards/${boardId}/files?path=${encodeURIComponent(path)}${hash}`;

export const fetchRuntimePanels = (boardId: string, mode: string) =>
  getJson<{ panels: RuntimePanel[] }>(`/api/runtime/panels?mode=${encodeURIComponent(mode)}&board=${boardId}`).then((body) => body.panels);

export const runPanelAction = async (boardId: string, mode: string, panelId: string, rowId: string, actionId: string): Promise<void> => {
  await readJson(await fetch(`/api/runtime/panels/${encodeURIComponent(panelId)}/${encodeURIComponent(rowId)}/${encodeURIComponent(actionId)}?mode=${encodeURIComponent(mode)}&board=${boardId}`, { method: "POST" }));
};

export const fetchTelemetry = () => getJson<TelemetryOverview>("/api/telemetry");
