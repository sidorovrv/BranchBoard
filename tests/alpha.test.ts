import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activeRollOf,
  answerText,
  boardTokenUsage,
  budgetStateOf,
  describeContext,
  estimateAttachmentTokens,
  expandSlashCommand,
  IMAGE_ATTACHMENT_TOKENS,
  isSummaryUsable,
  liveEdges,
  mentionTokensOf,
  parseTodoItems,
  planSession,
  renderInput,
  satelliteIdsOf,
  type BoardView,
  type GraphNode,
  type TrashListing,
} from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { resolveMentions } from "../packages/server/src/run/mentions";
import { searchWorkspaceFiles } from "../packages/server/src/workspaceFiles";
import { buildGraph, finishedParts, mustApply } from "./support";

const PORT = 47125;
const security = { port: PORT, extraOrigins: [] };
const trusted = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };

const directory = mkdtempSync(join(tmpdir(), "branchboard-alpha-"));
const workspace = join(directory, "workspace");
let server: ReturnType<typeof createApp>;

const request = async (path: string, body?: unknown, headers: Record<string, string> = trusted, rawBody?: string) => {
  const response = await server.app.request(`http://127.0.0.1:${PORT}${path}`, {
    method: body || rawBody ? "POST" : "GET",
    headers,
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
};

const command = (body: Record<string, unknown>) => request("/api/commands", body);
const view = async (boardId: string): Promise<BoardView> => (await request(`/api/boards/${boardId}/graph`)).json;
const nodeOf = async (boardId: string, nodeId: string): Promise<GraphNode> => (await view(boardId)).graph.nodes[nodeId];
const trash = async (): Promise<TrashListing> => (await request("/api/trash")).json;

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
};

const waitForStatus = (boardId: string, nodeId: string, status: string) => waitFor(async () => (await nodeOf(boardId, nodeId)).status === status);

const textOf = async (boardId: string, nodeId: string) => {
  const current = await view(boardId);
  return answerText(current.parts[nodeId], activeRollOf(current.graph.nodes[nodeId]));
};

const newBoard = async (title: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const created = (await command({ type: "createBoard", title, workspacePath: workspace, mode: "fake" })).json.id as string;
  if (Object.keys(extra).length > 0) await command({ type: "updateBoard", boardId: created, ...extra });
  return created;
};

const runLogRecords = (boardId: string): any[] =>
  readFileSync(join(directory, "run-logs", `${boardId}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

beforeAll(() => {
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "notes.md"), "project notes");
  writeFileSync(join(workspace, "src", "main.ts"), "export const answer = 42;");
  writeFileSync(join(workspace, ".gitignore"), "secret.txt\n");
  writeFileSync(join(workspace, "secret.txt"), "hidden");
  server = createApp({ databasePath: join(directory, "alpha.db"), security, webRoot: join(directory, "none") });
});

afterAll(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("AL-1 provider errors", () => {
  it("a run that only fails ends as an error with the message kept", async () => {
    const boardId = await newBoard("errors");
    const nodeId = (await command({ type: "reply", boardId, prompt: "/fail now" })).json.nodeId;
    await waitForStatus(boardId, nodeId, "error");
    const parts = (await view(boardId)).parts[nodeId];
    expect(parts.some((part) => part.type === "error" && part.text.includes("provider failed"))).toBe(true);
    expect(runLogRecords(boardId).find((record) => record.event === "end" && record.nodeId === nodeId).status).toBe("error");
  });

  it("an errored node can be reopened and regenerated", async () => {
    const boardId = await newBoard("errors again");
    const nodeId = (await command({ type: "reply", boardId, prompt: "/fail once" })).json.nodeId;
    await waitForStatus(boardId, nodeId, "error");
    expect((await command({ type: "regenerate", boardId, nodeId })).status).toBe(200);
    await waitForStatus(boardId, nodeId, "error");
    expect((await nodeOf(boardId, nodeId)).rollCount).toBe(2);
  });

  it("a normal run still ends as done", async () => {
    const boardId = await newBoard("fine");
    const nodeId = (await command({ type: "reply", boardId, prompt: "all good" })).json.nodeId;
    await waitForStatus(boardId, nodeId, "done");
  });
});

describe("AL-2 attachments", () => {
  const attachment = (mime: string, size: number) => ({ id: "a", name: "f", mime, size });

  it("estimates images with a fixed cost and other files by size", () => {
    expect(estimateAttachmentTokens(attachment("image/png", 5))).toBe(IMAGE_ATTACHMENT_TOKENS);
    expect(estimateAttachmentTokens(attachment("text/plain", 400))).toBe(100);
    expect(estimateAttachmentTokens(attachment("application/pdf", 4000))).toBe(1000);
  });

  it("counts attachments in the context size and republished tokens, and marks them approximate", () => {
    let graph = buildGraph(["a", "b"], [["a", "b"]]);
    graph = mustApply(graph, { type: "patch", patch: { nodes: { a: { id: "a", attachments: [attachment("image/png", 10)] } }, edges: {} } });
    const description = describeContext(graph, { a: finishedParts("a", "x") }, "b");
    expect(description.tokens).toBeGreaterThanOrEqual(IMAGE_ATTACHMENT_TOKENS);
    expect(description.republished).toBeGreaterThanOrEqual(IMAGE_ATTACHMENT_TOKENS);
    expect(description.isApproximate).toBe(true);
    const plain = describeContext(buildGraph(["a", "b"], [["a", "b"]]), {}, "b");
    expect(plain.isApproximate).toBe(false);
  });

  const upload = async (boardId: string, name: string, text: string) =>
    (await request(`/api/boards/${boardId}/attachments?name=${name}`, undefined, { ...trusted, "content-type": "text/plain" }, text)).json as { id: string };

  it("keeps a file while a deleted node can still be restored and removes it once the trash is emptied", async () => {
    const boardId = await newBoard("files");
    const file = await upload(boardId, "kept.txt", "keep me");
    const nodeId = (await command({ type: "file", boardId, attachmentIds: [file.id] })).json.nodeId;
    await command({ type: "deleteNodes", boardId, ids: [nodeId] });
    expect(server.trash.sweepAttachments(0)).toBe(0);
    expect(existsSync(join(directory, "attachments", file.id))).toBe(true);
    await command({ type: "emptyTrash" });
    expect(existsSync(join(directory, "attachments", file.id))).toBe(false);
  });

  it("removes an upload nothing references but only after the grace period", async () => {
    const boardId = await newBoard("orphan");
    const file = await upload(boardId, "loose.txt", "never attached");
    expect(server.trash.sweepAttachments()).toBe(0);
    expect(existsSync(join(directory, "attachments", file.id))).toBe(true);
    expect(server.trash.sweepAttachments(0)).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(directory, "attachments", file.id))).toBe(false);
  });

  it("keeps a file that only an undo could bring back", async () => {
    const boardId = await newBoard("undo detach");
    const file = await upload(boardId, "undo.txt", "undo me");
    const nodeId = (await command({ type: "reply", boardId, prompt: "", run: false })).json.nodeId;
    await command({ type: "attach", boardId, nodeId, attachmentIds: [file.id] });
    await command({ type: "detach", boardId, nodeId, attachmentId: file.id });
    expect(server.trash.sweepAttachments(0)).toBe(0);
    await command({ type: "undo", boardId });
    expect((await nodeOf(boardId, nodeId)).attachments).toHaveLength(1);
  });
});

describe("AL-3 and AL-4 subagents and todos", () => {
  it("shows the todo list as a part that updates in place and keeps it out of the context", async () => {
    const boardId = await newBoard("todos");
    const nodeId = (await command({ type: "reply", boardId, prompt: "/todo plan" })).json.nodeId;
    await waitForStatus(boardId, nodeId, "done");
    const todo = (await view(boardId)).parts[nodeId].find((part) => part.type === "todo");
    expect(todo?.meta?.items).toEqual([
      { content: "Read the notes", status: "completed" },
      { content: "Write the answer", status: "in_progress" },
    ]);
    expect(await textOf(boardId, nodeId)).not.toContain("Read the notes");
  });

  it("turns a subagent into a satellite beside its parent that never feeds anything", async () => {
    const boardId = await newBoard("satellites");
    const parentId = (await command({ type: "reply", boardId, prompt: "/subagent go" })).json.nodeId;
    await waitForStatus(boardId, parentId, "done");
    const current = await view(boardId);
    const satelliteIds = satelliteIdsOf(current.graph, parentId);
    expect(satelliteIds).toHaveLength(1);
    const satellite = current.graph.nodes[satelliteIds[0]];
    expect(satellite).toMatchObject({ kind: "subagent", title: "Helper", status: "done", satelliteOf: parentId });
    const parent = current.graph.nodes[parentId];
    expect(satellite.x).toBeGreaterThanOrEqual(parent.x + parent.w);
    expect(satellite.y).toBe(parent.y);
    expect(await textOf(boardId, satellite.id)).toBe("helper says hi");
    expect(liveEdges(current.graph).filter((edge) => edge.fromId === satellite.id || edge.toId === satellite.id)).toHaveLength(0);
    const refused = await command({ type: "connect", boardId, fromId: satellite.id, toId: parentId });
    expect(refused.status).toBe(409);
    const child = (await command({ type: "reply", boardId, parentIds: [parentId], prompt: "next" })).json.nodeId;
    await waitForStatus(boardId, child, "done");
    expect(await textOf(boardId, child)).not.toContain("helper says hi");
  });

  it("shows a subagent's approval inside the satellite and pauses the parent", async () => {
    const boardId = await newBoard("satellite approval");
    const parentId = (await command({ type: "reply", boardId, prompt: "/subagent ask" })).json.nodeId;
    await waitForStatus(boardId, parentId, "awaiting_approval");
    const current = await view(boardId);
    const open = Object.values(current.requests).filter((candidate) => candidate.status === "open");
    expect(open).toHaveLength(1);
    expect(current.graph.nodes[open[0].nodeId].kind).toBe("subagent");
    await command({ type: "answerRequest", boardId, requestId: open[0].id, answer: "once" });
    await waitForStatus(boardId, parentId, "done");
  });

  it("deletes the satellites with their parent and restores them together", async () => {
    const boardId = await newBoard("satellite delete");
    const parentId = (await command({ type: "reply", boardId, prompt: "/subagent go" })).json.nodeId;
    await waitForStatus(boardId, parentId, "done");
    const satelliteId = satelliteIdsOf((await view(boardId)).graph, parentId)[0];
    await command({ type: "deleteNodes", boardId, ids: [parentId] });
    expect((await nodeOf(boardId, satelliteId)).deleted).toBe(true);
    const group = (await trash()).nodeGroups.find((entry) => entry.boardId === boardId)!;
    expect(group.nodeIds).toEqual(expect.arrayContaining([parentId, satelliteId]));
    await command({ type: "restoreNodes", boardId, ids: group.nodeIds });
    expect((await nodeOf(boardId, satelliteId)).deleted).toBe(false);
  });

  it("parses todo items from the shapes the runtimes send", () => {
    expect(parseTodoItems([{ content: "a", status: "pending" }, { activeForm: "b", status: "in-progress" }, { content: " ", status: "pending" }, { content: "c", status: "cancelled" }])).toEqual([
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" },
    ]);
    expect(parseTodoItems("nope")).toEqual([]);
  });
});

describe("AL-5 slash commands and mentions", () => {
  it("expands a catalog command with its arguments", () => {
    const commands = [{ name: "review", template: "Please review: $ARGUMENTS" }, { name: "pair", template: "First $1 then $2" }, { name: "plain", template: "Do the thing." }];
    expect(expandSlashCommand("/review the parser", commands).text).toBe("Please review: the parser");
    expect(expandSlashCommand("/pair a b", commands).text).toBe("First a then b");
    expect(expandSlashCommand("/plain extra words", commands).text).toBe("Do the thing.\n\nextra words");
    expect(expandSlashCommand("/unknown x", commands)).toEqual({ text: "/unknown x" });
    expect(expandSlashCommand("not a command", commands).command).toBeUndefined();
  });

  it("sends a pass-through command exactly as typed", () => {
    const commands = [{ name: "security-review", template: "", passThrough: true }];
    expect(expandSlashCommand("  /security-review src  ", commands).text).toBe("/security-review src");
  });

  it("finds mention tokens and ignores email addresses and trailing punctuation", () => {
    expect(mentionTokensOf("look at @src/main.ts, and @notes.md. Mail a@b.com")).toEqual(["src/main.ts", "notes.md"]);
  });

  it("resolves mentions to files inside the workspace only", () => {
    const resolved = resolveMentions("see @notes.md @src/main.ts @../outside.txt @missing.md @planner", workspace, ["planner"]);
    expect(resolved.files.map((file) => file.name).sort()).toEqual(["main.ts", "notes.md"]);
    expect(resolved.agent).toBe("planner");
    expect(resolved.files.find((file) => file.name === "main.ts")?.mime).toBe("text/plain");
  });

  it("sends the expanded command to the runtime and keeps the typed prompt on the node", async () => {
    const boardId = await newBoard("commands");
    const nodeId = (await command({ type: "reply", boardId, prompt: "/review the parser" })).json.nodeId;
    await waitForStatus(boardId, nodeId, "done");
    expect(await textOf(boardId, nodeId)).toContain("Please review: the parser");
    expect((await nodeOf(boardId, nodeId)).prompt).toBe("/review the parser");
    expect(runLogRecords(boardId).find((record) => record.event === "start").command).toBe("review");
  });

  it("attaches mentioned files for that run and switches to a mentioned agent", async () => {
    const boardId = await newBoard("mentions");
    const nodeId = (await command({ type: "reply", boardId, prompt: "read @notes.md with @plan" })).json.nodeId;
    await waitForStatus(boardId, nodeId, "done");
    const start = runLogRecords(boardId).find((record) => record.event === "start");
    expect(start.files).toEqual([{ name: "notes.md", mime: "text/plain" }]);
    expect(start.agent).toBe("plan");
    expect((await nodeOf(boardId, nodeId)).agent).not.toBe("plan");
  });

  it("searches workspace files, skipping ignored and hidden ones", async () => {
    expect(searchWorkspaceFiles(workspace, "main")).toEqual(["src/main.ts"]);
    expect(searchWorkspaceFiles(workspace, "secret")).toEqual([]);
    const boardId = await newBoard("files search");
    const found = await request(`/api/workspace/files?board=${boardId}&q=notes`);
    expect(found.json).toEqual(["notes.md"]);
  });

  it("lists the runtime's commands in the catalog", async () => {
    const catalog = (await request("/api/runtime/catalog?mode=fake")).json;
    expect(catalog.commands.map((entry: { name: string }) => entry.name)).toContain("review");
  });
});

describe("AL-6 pinning", () => {
  it("a pinned node ignores moves and resizes but unpinning frees it", async () => {
    const boardId = await newBoard("pins");
    const nodeId = (await command({ type: "reply", boardId, prompt: "", run: false, position: { x: 10, y: 20 } })).json.nodeId;
    await command({ type: "pin", boardId, nodeId, pinned: true });
    await command({ type: "moveNodes", boardId, positions: { [nodeId]: { x: 500, y: 600, w: 700 } } });
    expect(await nodeOf(boardId, nodeId)).toMatchObject({ x: 10, y: 20, pinned: true });
    await command({ type: "pin", boardId, nodeId });
    await command({ type: "moveNodes", boardId, positions: { [nodeId]: { x: 500, y: 600 } } });
    expect(await nodeOf(boardId, nodeId)).toMatchObject({ x: 500, y: 600, pinned: false });
  });

  it("undo restores the previous pin state", async () => {
    const boardId = await newBoard("pin undo");
    const nodeId = (await command({ type: "reply", boardId, prompt: "", run: false })).json.nodeId;
    await command({ type: "pin", boardId, nodeId, pinned: true });
    await command({ type: "undo", boardId });
    expect((await nodeOf(boardId, nodeId)).pinned).toBeFalsy();
  });
});

describe("AL-7 trash", () => {
  it("restores a deleted node with the edges that went with it", async () => {
    const boardId = await newBoard("restore nodes");
    const parentId = (await command({ type: "reply", boardId, prompt: "parent" })).json.nodeId;
    await waitForStatus(boardId, parentId, "done");
    const childId = (await command({ type: "reply", boardId, parentIds: [parentId], prompt: "child" })).json.nodeId;
    await waitForStatus(boardId, childId, "done");
    await command({ type: "deleteNodes", boardId, ids: [childId] });
    const group = (await trash()).nodeGroups.find((entry) => entry.boardId === boardId)!;
    expect(group.titles).toHaveLength(1);
    expect(liveEdges((await view(boardId)).graph)).toHaveLength(0);
    expect((await command({ type: "restoreNodes", boardId, ids: group.nodeIds })).status).toBe(200);
    const restored = (await view(boardId)).graph;
    expect(restored.nodes[childId].deleted).toBe(false);
    expect(liveEdges(restored).some((edge) => edge.fromId === parentId && edge.toId === childId)).toBe(true);
    expect((await trash()).nodeGroups.some((entry) => entry.boardId === boardId)).toBe(false);
  });

  it("skips a restored edge that would now create a cycle", async () => {
    const boardId = await newBoard("restore cycle");
    const first = (await command({ type: "reply", boardId, prompt: "first", run: false })).json.nodeId;
    const second = (await command({ type: "reply", boardId, parentIds: [first], prompt: "second", run: false })).json.nodeId;
    await command({ type: "deleteNodes", boardId, ids: [second] });
    const group = (await trash()).nodeGroups.find((entry) => entry.boardId === boardId)!;
    await command({ type: "restoreNodes", boardId, ids: group.nodeIds });
    expect(liveEdges((await view(boardId)).graph).filter((edge) => edge.toId === second)).toHaveLength(1);
  });

  it("refuses to restore a node that is not in the trash", async () => {
    const boardId = await newBoard("restore refusal");
    const nodeId = (await command({ type: "reply", boardId, prompt: "", run: false })).json.nodeId;
    expect((await command({ type: "restoreNodes", boardId, ids: [nodeId] })).status).toBe(409);
  });

  it("lists a deleted board and brings it back", async () => {
    const boardId = await newBoard("board in the trash");
    await command({ type: "deleteBoard", boardId });
    expect((await trash()).boards.some((entry) => entry.id === boardId)).toBe(true);
    expect((await request("/api/boards")).json.some((entry: { id: string }) => entry.id === boardId)).toBe(false);
    await command({ type: "restoreBoard", boardId });
    expect((await request("/api/boards")).json.some((entry: { id: string }) => entry.id === boardId)).toBe(true);
    expect((await trash()).boards.some((entry) => entry.id === boardId)).toBe(false);
  });

  it("deletes a project with its boards and restores both", async () => {
    const projectDirectory = join(directory, "second-project");
    mkdirSync(projectDirectory, { recursive: true });
    const project = (await command({ type: "createProject", workspacePath: projectDirectory, mode: "fake", name: "Second" })).json;
    const boardId = (await command({ type: "createBoard", projectId: project.id, title: "inside" })).json.id;
    await command({ type: "deleteProject", projectId: project.id });
    const listing = await trash();
    expect(listing.projects.find((entry) => entry.id === project.id)?.boardCount).toBe(1);
    expect(listing.boards.some((entry) => entry.id === boardId)).toBe(false);
    await command({ type: "restoreProject", projectId: project.id });
    expect((await request("/api/projects")).json.some((entry: { id: string }) => entry.id === project.id)).toBe(true);
    expect((await request("/api/boards")).json.some((entry: { id: string }) => entry.id === boardId)).toBe(true);
  });

  it("restoring a board also brings back a trashed project", async () => {
    const projectDirectory = join(directory, "third-project");
    mkdirSync(projectDirectory, { recursive: true });
    const project = (await command({ type: "createProject", workspacePath: projectDirectory, mode: "fake", name: "Third" })).json;
    const boardId = (await command({ type: "createBoard", projectId: project.id, title: "inside" })).json.id;
    await command({ type: "deleteProject", projectId: project.id });
    await command({ type: "restoreBoard", boardId });
    expect((await request("/api/projects")).json.some((entry: { id: string }) => entry.id === project.id)).toBe(true);
  });

  it("empties the trash for good", async () => {
    const boardId = await newBoard("to purge");
    const nodeId = (await command({ type: "reply", boardId, prompt: "gone", run: false })).json.nodeId;
    await command({ type: "deleteNodes", boardId, ids: [nodeId] });
    const other = await newBoard("whole board to purge");
    await command({ type: "deleteBoard", boardId: other });
    await command({ type: "emptyTrash" });
    const listing = await trash();
    expect(listing.nodeGroups).toHaveLength(0);
    expect(listing.boards).toHaveLength(0);
    expect(listing.projects).toHaveLength(0);
    expect((await view(boardId)).graph.nodes[nodeId]).toBeUndefined();
    expect((await request(`/api/boards/${other}/graph`)).status).toBe(409);
  });

  it("removes only the items older than the retention period at startup", async () => {
    const boardId = await newBoard("expiry");
    const nodeId = (await command({ type: "reply", boardId, prompt: "recent", run: false })).json.nodeId;
    await command({ type: "deleteNodes", boardId, ids: [nodeId] });
    server.trash.purgeExpired();
    expect((await trash()).nodeGroups.some((entry) => entry.boardId === boardId)).toBe(true);
  });
});

describe("AL-9 summaries", () => {
  const summarisedGraph = () => {
    let graph = buildGraph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
    const done = (id: string) => ({ id, status: "done" as const, contextHash: undefined, runtimeRef: undefined });
    graph = mustApply(graph, { type: "patch", patch: { nodes: { a: done("a"), b: done("b"), c: { ...done("c"), forceAssemble: true } }, edges: {} } });
    return graph;
  };
  const parts = { a: finishedParts("a", "answer a"), b: finishedParts("b", "answer b") };

  it("replaces the turns a usable summary covers and keeps the rest", () => {
    let graph = summarisedGraph();
    const plainPlan = planSession(graph, parts, "c");
    expect(plainPlan.missingTurns.map((turn) => turn.kind)).toEqual(["turn", "turn"]);
    graph = mustApply(graph, { type: "patch", patch: { nodes: { b: { id: "b", summary: { text: "A and B in short", coveredNodeIds: ["a", "b"], contextHash: "", rev: 0, tokens: 4 } } }, edges: {} } });
    graph = mustApply(graph, { type: "patch", patch: { nodes: { b: { id: "b", summary: { ...graph.nodes.b.summary!, contextHash: describeContext(graph, parts, "b").hash } } }, edges: {} } });
    expect(isSummaryUsable(graph, graph.nodes.b)).toBe(true);
    const plan = planSession(graph, parts, "c");
    expect(plan.missingTurns).toHaveLength(1);
    expect(plan.missingTurns[0]).toMatchObject({ kind: "summary", coveredNodeIds: ["a", "b"] });
    const input = renderInput(plan, "next question");
    expect(input).toContain("[summary of the earlier conversation]");
    expect(input).toContain("A and B in short");
    expect(input).not.toContain("answer a");
    expect(describeContext(graph, parts, "c").summarisedNodeIds).toEqual(["a", "b"]);
  });

  it("stops using a summary once a covered node changes", () => {
    let graph = summarisedGraph();
    graph = mustApply(graph, { type: "patch", patch: { nodes: { b: { id: "b", summary: { text: "short", coveredNodeIds: ["a", "b"], contextHash: describeContext(graph, parts, "b").hash, rev: 0, tokens: 1 } } }, edges: {} } });
    expect(isSummaryUsable(graph, graph.nodes.b)).toBe(true);
    graph = mustApply(graph, { type: "patch", patch: { nodes: { a: { id: "a", rev: 1 } }, edges: {} } });
    expect(isSummaryUsable(graph, graph.nodes.b)).toBe(false);
    expect(planSession(graph, parts, "c").missingTurns.map((turn) => turn.kind)).toEqual(["turn", "turn"]);
  });

  it("summarises on request and uses the summary when the context has to be re-sent", async () => {
    const boardId = await newBoard("summaries");
    const first = (await command({ type: "reply", boardId, prompt: "first topic" })).json.nodeId;
    await waitForStatus(boardId, first, "done");
    const second = (await command({ type: "reply", boardId, parentIds: [first], prompt: "second topic" })).json.nodeId;
    await waitForStatus(boardId, second, "done");
    expect((await command({ type: "summarise", boardId, nodeId: second })).status).toBe(200);
    const summary = (await nodeOf(boardId, second)).summary!;
    expect(summary.coveredNodeIds).toEqual([first, second]);
    expect(summary.text.length).toBeGreaterThan(0);
    const third = (await command({ type: "reply", boardId, parentIds: [second], prompt: "", run: false })).json.nodeId;
    await command({ type: "editNode", boardId, nodeId: third, fields: { forceAssemble: true, prompt: "third topic" } });
    await command({ type: "regenerate", boardId, nodeId: third });
    await waitForStatus(boardId, third, "done");
    const answer = await textOf(boardId, third);
    expect(answer).toContain("[summary of the earlier conversation]");
    expect(answer).toContain("third topic");
  });

  it("refuses to summarise a chat that has not finished and can clear a summary", async () => {
    const boardId = await newBoard("summary refusal");
    const idle = (await command({ type: "reply", boardId, prompt: "", run: false })).json.nodeId;
    expect((await command({ type: "summarise", boardId, nodeId: idle })).status).toBe(409);
    const done = (await command({ type: "reply", boardId, prompt: "topic" })).json.nodeId;
    await waitForStatus(boardId, done, "done");
    await command({ type: "summarise", boardId, nodeId: done });
    expect((await nodeOf(boardId, done)).summary?.text).toBeTruthy();
    await command({ type: "clearSummary", boardId, nodeId: done });
    expect((await nodeOf(boardId, done)).summary?.text).toBe("");
  });

  it("summarises an ancestor first when the re-sent context is over the board's share of the window", async () => {
    const boardId = await newBoard("auto summary", { summaryShare: 0.0001 });
    const first = (await command({ type: "reply", boardId, prompt: "background one" })).json.nodeId;
    await waitForStatus(boardId, first, "done");
    const second = (await command({ type: "reply", boardId, parentIds: [first], prompt: "background two" })).json.nodeId;
    await waitForStatus(boardId, second, "done");
    const third = (await command({ type: "reply", boardId, parentIds: [second], prompt: "", run: false })).json.nodeId;
    await command({ type: "editNode", boardId, nodeId: third, fields: { forceAssemble: true } });
    await command({ type: "run", boardId, nodeId: third, prompt: "continue" });
    await waitForStatus(boardId, third, "done");
    expect((await nodeOf(boardId, second)).summary?.text).toBeTruthy();
    expect(await textOf(boardId, third)).toContain("[summary of the earlier conversation]");
  });

  it("never summarises on its own when the share is zero", async () => {
    const boardId = await newBoard("no auto summary", { summaryShare: 0 });
    const first = (await command({ type: "reply", boardId, prompt: "one" })).json.nodeId;
    await waitForStatus(boardId, first, "done");
    const second = (await command({ type: "reply", boardId, parentIds: [first], prompt: "two" })).json.nodeId;
    await waitForStatus(boardId, second, "done");
    const third = (await command({ type: "reply", boardId, parentIds: [second], prompt: "", run: false })).json.nodeId;
    await command({ type: "editNode", boardId, nodeId: third, fields: { forceAssemble: true } });
    await command({ type: "run", boardId, nodeId: third, prompt: "three" });
    await waitForStatus(boardId, third, "done");
    expect((await nodeOf(boardId, second)).summary).toBeUndefined();
  });
});

describe("AL-10 budgets", () => {
  it("measures usage per board and classifies it against the budget", async () => {
    expect(budgetStateOf(10, undefined)).toBe("none");
    expect(budgetStateOf(10, 100)).toBe("ok");
    expect(budgetStateOf(80, 100)).toBe("warning");
    expect(budgetStateOf(100, 100)).toBe("exhausted");
    const boardId = await newBoard("usage");
    const nodeId = (await command({ type: "reply", boardId, prompt: "count my tokens" })).json.nodeId;
    await waitForStatus(boardId, nodeId, "done");
    const usage = boardTokenUsage((await view(boardId)).graph);
    expect(usage).toBeGreaterThan(0);
    const node = await nodeOf(boardId, nodeId);
    expect(usage).toBe(node.usage!.inputTokens + node.usage!.outputTokens);
  });

  it("refuses new runs once the budget is used and allows them again when it is raised", async () => {
    const boardId = await newBoard("budget", { budgetTokens: 1 });
    const first = (await command({ type: "reply", boardId, prompt: "use the budget" })).json.nodeId;
    await waitForStatus(boardId, first, "done");
    const refused = await command({ type: "reply", boardId, prompt: "over the budget" });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/budget/);
    await command({ type: "updateBoard", boardId, budgetTokens: 1000000 });
    const allowed = await command({ type: "reply", boardId, prompt: "within the budget" });
    expect(allowed.status).toBe(200);
    await waitForStatus(boardId, allowed.json.nodeId, "done");
    await command({ type: "updateBoard", boardId, budgetTokens: 0 });
    expect((await request(`/api/boards/${boardId}/graph`)).json.board.budgetTokens).toBeUndefined();
  });
});

describe("AL-11 health and logs", () => {
  it("reports the health of a runtime and its diagnostics", async () => {
    const health = (await request(`/api/health?runtime=fake&workspace=${encodeURIComponent(workspace)}`)).json;
    expect(health.runtimes).toHaveLength(1);
    expect(health.runtimes[0]).toMatchObject({ id: "fake", isOk: true });
  });

  it("refuses an unknown runtime", async () => {
    expect((await request("/api/health?runtime=nope")).status).toBe(409);
  });

  it("returns an empty log when no log file is configured", async () => {
    expect((await request("/api/logs")).json).toEqual({ lines: [] });
  });
});

describe("board activity", () => {
  const unseen = async (boardId: string) => ((await request("/api/boards")).json as { id: string; hasUnseenResult?: boolean }[]).find((board) => board.id === boardId)?.hasUnseenResult === true;

  it("flags a board whose runs finished until it is marked as seen", async () => {
    const boardId = await newBoard("activity");
    expect(await unseen(boardId)).toBe(false);
    const nodeId = (await command({ type: "reply", boardId, prompt: "hello" })).json.nodeId;
    await waitForStatus(boardId, nodeId, "done");
    await waitFor(() => unseen(boardId));
    await command({ type: "markBoardSeen", boardId });
    expect(await unseen(boardId)).toBe(false);
  });

  const hitLimit = async (boardId: string) => ((await request("/api/boards")).json as { id: string; hitUsageLimit?: boolean }[]).find((board) => board.id === boardId)?.hitUsageLimit === true;

  it("flags a board whose run hit the usage limit until a later run succeeds", async () => {
    const boardId = await newBoard("limit");
    const limited = (await command({ type: "reply", boardId, prompt: "/limit" })).json.nodeId;
    await waitForStatus(boardId, limited, "error");
    await waitFor(() => hitLimit(boardId));
    const failed = (await command({ type: "reply", boardId, prompt: "/fail" })).json.nodeId;
    await waitForStatus(boardId, failed, "error");
    expect(await hitLimit(boardId)).toBe(true);
    const fine = (await command({ type: "reply", boardId, prompt: "hello" })).json.nodeId;
    await waitForStatus(boardId, fine, "done");
    await waitFor(async () => !(await hitLimit(boardId)));
  });
});
