import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNodeClipboard, INLINE_TOOL_OUTPUT_CHARS, type BoardView, type Part } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";

const PORT = 47131;
const trusted = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
const directory = mkdtempSync(join(tmpdir(), "branchboard-tool-outputs-"));
const server = createApp({ databasePath: join(directory, "test.db"), security: { port: PORT, extraOrigins: [] }, webRoot: join(directory, "none") });

const request = async (path: string, body?: unknown) => {
  const response = await server.app.request(`http://127.0.0.1:${PORT}${path}`, { method: body ? "POST" : "GET", headers: trusted, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: await response.json() };
};

const view = async (): Promise<BoardView> => (await request(`/api/boards/${boardId}/graph`)).json;

const toolPartOf = (parts: Part[] | undefined): Part => parts!.find((part) => part.type === "tool")!;

const LONG_OUTPUT = "x".repeat(INLINE_TOOL_OUTPUT_CHARS + 1);

let boardId = "";
let nodeId = "";

beforeAll(async () => {
  boardId = (await request("/api/commands", { type: "createBoard", title: "Tools", workspacePath: process.cwd(), mode: "fake" })).json.id;
  nodeId = (await request("/api/commands", { type: "reply", boardId, prompt: "hello" })).json.nodeId;
  while ((await view()).graph.nodes[nodeId].status !== "done") await new Promise((resolve) => setTimeout(resolve, 25));
  server.boards.recordRunEvent(boardId, nodeId, { type: "tool.started", partKey: "long", tool: "bash", description: "ls", input: { command: "ls" } });
  server.boards.recordRunEvent(boardId, nodeId, { type: "tool.done", partKey: "long", output: LONG_OUTPUT, isError: false });
  server.boards.flushParts(boardId, nodeId);
});

afterAll(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("long tool outputs", () => {
  it("are left out of the board download with their length", async () => {
    const part = toolPartOf((await view()).parts[nodeId]);
    expect(part.meta?.output).toBeUndefined();
    expect(part.meta?.outputChars).toBe(LONG_OUTPUT.length);
  });

  it("load through the tool output route", async () => {
    const part = toolPartOf((await view()).parts[nodeId]);
    const response = await request(`/api/boards/${boardId}/tool-output?node=${encodeURIComponent(nodeId)}&part=${encodeURIComponent(part.id)}`);
    expect(response.json.output).toBe(LONG_OUTPUT);
  });

  it("keep short outputs in the download after the board changes", async () => {
    server.boards.recordRunEvent(boardId, nodeId, { type: "tool.started", partKey: "short", tool: "bash", description: "pwd", input: { command: "pwd" } });
    server.boards.recordRunEvent(boardId, nodeId, { type: "tool.done", partKey: "short", output: "/home", isError: false });
    const outputs = (await view()).parts[nodeId].filter((part) => part.type === "tool").map((part) => part.meta?.output);
    expect(outputs).toEqual([undefined, "/home"]);
  });

  it("come back in full when the copied node is pasted", async () => {
    const current = await view();
    const clipboard = buildNodeClipboard(current.graph, current.parts, [nodeId]);
    const pasted = (await request("/api/commands", { type: "pasteNodes", boardId, clipboard })).json.nodeIds[0];
    expect(toolPartOf(server.boards.stateOf(boardId).parts[pasted]).meta?.output).toBe(LONG_OUTPUT);
  });
});
