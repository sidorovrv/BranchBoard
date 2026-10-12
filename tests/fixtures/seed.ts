import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectBoard, encoders, type Board, type BoardDocument } from "@branchboard/core";
import { createApp } from "../../packages/server/src/app";

const PORT = 47190;
const HOST_HEADERS = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const DATABASE_NAME = "branchboard.db";
export const EXPECTED_NAME = "expected.branchboard.json";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export const normaliseDocument = (document: unknown): string => {
  const clearedTimes = JSON.stringify(document, (key, value) => (/(At|Ms)$/.test(key) && typeof value === "number" ? 0 : value));
  const seen = new Map<string, string>();
  return clearedTimes.replace(UUID, (id) => seen.get(id) ?? (seen.set(id, `id-${seen.size}`), seen.get(id)!));
};

export const seedFixtureBoard = async (dataDirectory: string): Promise<BoardDocument[]> => {
  const workspace = join(dataDirectory, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "hello.ts"), "export const hello = () => 'hello';\n");
  const server = createApp({ databasePath: join(dataDirectory, DATABASE_NAME), security: { port: PORT, extraOrigins: [] } });

  const call = async (path: string, init: RequestInit) => {
    const response = await server.app.request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { ...HOST_HEADERS, ...(init.headers as object) } });
    const body = await response.json();
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
    return body;
  };
  const command = (body: Record<string, unknown>) => call("/api/commands", { method: "POST", body: JSON.stringify(body) });
  const nodeStatus = async (boardId: string, nodeId: string): Promise<string> => (await call(`/api/boards/${boardId}/graph`, {})).graph.nodes[nodeId].status;
  const settle = async (boardId: string, nodeId: string) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (["done", "error"].includes(await nodeStatus(boardId, nodeId))) return;
      await sleep(25);
    }
    throw new Error("A fixture node never finished");
  };

  const project = await command({ type: "createProject", workspacePath: workspace, mode: "fake", name: "Fixture project" });
  const board: Board = await command({ type: "createBoard", projectId: project.id, title: "Fixture board" });
  const boardId = board.id;
  const reply = async (body: Record<string, unknown>) => {
    const { nodeId } = await command({ type: "reply", boardId, ...body });
    if (body.run !== false) await settle(boardId, nodeId);
    return nodeId as string;
  };

  const root = await reply({ prompt: "Root question" });
  const child = await reply({ parentIds: [root], prompt: "Follow up" });
  await command({ type: "regenerate", boardId, nodeId: child });
  await sleep(50);
  await settle(boardId, child);
  const sibling = await reply({ parentIds: [root], prompt: "Second branch" });
  await command({ type: "pin", boardId, nodeId: sibling, pinned: true });
  await command({ type: "note", boardId, originId: root, prompt: "A note feeding the branch" });
  const stored = await call(`/api/boards/${boardId}/attachments?name=notes.txt`, { method: "POST", headers: { "content-type": "text/plain" }, body: "attached text" });
  await command({ type: "file", boardId, attachmentIds: [stored.id] });
  await command({ type: "extractFile", boardId, originId: child, path: "hello.ts" });
  const discarded = await reply({ prompt: "Discard me", run: false });
  await command({ type: "deleteNodes", boardId, ids: [discarded] });
  await command({ type: "reopen", boardId, nodeId: root });
  await command({ type: "editNode", boardId, nodeId: root, fields: { prompt: "Root question, edited" } });

  await command({ type: "saveNow", boardId });
  const state = server.boards.stateOf(boardId);
  const documents = [collectBoard(state)];
  server.close();
  return documents;
};

export const expectedTextOf = (documents: BoardDocument[]): string => normaliseDocument(documents.map((document) => JSON.parse(encoders.json(document))));
