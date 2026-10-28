import { activeRollOf, answerText, applyPatch, emptyGraph, isRefusal, makeNode, runEdit, type BoardGraph, type BoardView, type GraphEdit, type GraphNode, type Id, type Part } from "@branchboard/core";
import type { createApp } from "../packages/server/src/app";
import { createChannel } from "../packages/server/src/run/channel";
import type { ProcessExit, RunningProcess } from "../packages/server/src/runtimes/spawnProcess";

export const BOARD = "board-1";

export const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

export const trustedHeaders = (port: number) => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" });

const parsedJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const appClient = (appOf: () => Pick<ReturnType<typeof createApp>, "app">, port: number) => {
  const trusted = trustedHeaders(port);
  const send = async (path: string, init: RequestInit = {}) => appOf().app.request(`http://127.0.0.1:${port}${path}`, { headers: trusted, ...init });
  const request = async (path: string, body?: unknown, headers: Record<string, string> = trusted) => {
    const response = await send(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: text ? parsedJson(text) : undefined };
  };
  const view = async (boardId: string): Promise<BoardView & { board: any }> => (await request(`/api/boards/${boardId}/graph`)).json;
  const nodeOf = async (boardId: string, nodeId: string): Promise<GraphNode> => (await view(boardId)).graph.nodes[nodeId];
  return {
    trusted,
    send,
    request,
    view,
    nodeOf,
    command: (body: Record<string, unknown>) => request("/api/commands", body),
    waitForStatus: (boardId: string, nodeId: string, status: string, timeoutMs?: number) => waitFor(async () => (await nodeOf(boardId, nodeId))?.status === status, timeoutMs),
    textOf: async (boardId: string, nodeId: string) => {
      const current = await view(boardId);
      return answerText(current.parts[nodeId], activeRollOf(current.graph.nodes[nodeId]));
    },
    openRequests: async (boardId: string) => Object.values((await view(boardId)).requests).filter((candidate) => candidate.status === "open"),
  };
};

export class ScriptedProcess implements RunningProcess {
  input = "";
  wasKilled = false;
  private readonly channel = createChannel<string>();
  private finishExit!: (exit: ProcessExit) => void;
  readonly lines = this.channel.iterator;
  readonly exit = new Promise<ProcessExit>((resolve) => (this.finishExit = resolve));

  writeInput(text: string) {
    this.input += text;
  }
  endInput() {}
  emit(message: unknown) {
    this.channel.push(JSON.stringify(message));
  }
  emitLine(text: string) {
    this.channel.push(text);
  }
  finish(code: number | null = 0, stderrTail = "") {
    this.channel.close();
    this.finishExit({ code, stderrTail });
  }
  kill() {
    this.wasKilled = true;
    this.finish(null);
  }
}

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
