import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeRollOf, answerText, encodeAnswers, isStale, liveEdges, REJECTED_ANSWER, type BoardView, type GraphNode } from "@branchboard/core";
import { ACCESS_COOKIE, ACCESS_QUERY, cookieValueOf, loadAccessToken } from "../packages/server/src/accessToken";
import { createApp } from "../packages/server/src/app";
import { isUpgradeAllowed } from "../packages/server/src/security";

const PORT = 47123;
const security = { port: PORT, extraOrigins: [] };
const trusted = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };

const directory = mkdtempSync(join(tmpdir(), "branchboard-"));
const databasePath = join(directory, "test.db");
let server: ReturnType<typeof createApp>;

const request = async (path: string, body?: unknown, headers: Record<string, string> = trusted) => {
  const response = await server.app.request(`http://127.0.0.1:${PORT}${path}`, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, json: text ? safeParse(text) : undefined, text };
};

const safeParse = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const command = (body: Record<string, unknown>) => request("/api/commands", body);

const view = async (boardId: string): Promise<BoardView & { board: unknown }> => (await request(`/api/boards/${boardId}/graph`)).json;

const nodeOf = async (boardId: string, nodeId: string): Promise<GraphNode> => (await view(boardId)).graph.nodes[nodeId];

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
};

const waitForStatus = (boardId: string, nodeId: string, status: string) => waitFor(async () => (await nodeOf(boardId, nodeId)).status === status);

const textOf = async (boardId: string, nodeId: string) => {
  const current = await view(boardId);
  return answerText(current.parts[nodeId], activeRollOf(current.graph.nodes[nodeId]));
};

let boardId = "";

beforeAll(async () => {
  server = createApp({ databasePath, security, webRoot: join(directory, "none") });
  boardId = (await command({ type: "createBoard", title: "Demo", workspacePath: process.cwd(), mode: "fake" })).json.id;
});

afterAll(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("security", () => {
  it("rejects a foreign host on a read", async () => {
    expect((await request("/api/boards", undefined, { ...trusted, host: "evil.example:80" })).status).toBe(403);
  });

  it("needs no token on a read", async () => {
    expect((await request("/api/boards", undefined, { host: trusted.host })).status).toBe(200);
  });

  it("forbids framing the app on served pages and on refusals", async () => {
    const served = await server.app.request(`http://127.0.0.1:${PORT}/api/boards`, { headers: { host: trusted.host } });
    expect(served.headers.get("x-frame-options")).toBe("DENY");
    expect(served.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    const refused = await server.app.request(`http://127.0.0.1:${PORT}/api/boards`, { headers: { host: "evil.example:80" } });
    expect(refused.headers.get("x-frame-options")).toBe("DENY");
  });

  it("rejects a foreign origin on a write", async () => {
    const response = await request("/api/commands", { type: "undo", boardId }, { ...trusted, origin: "http://evil.example" });
    expect(response.status).toBe(403);
  });
});

describe("access key", () => {
  const accessToken = "ab".repeat(32);
  const locked = createApp({ databasePath: join(directory, "locked.db"), security: { port: PORT, extraOrigins: [], accessToken }, webRoot: join(directory, "none") });
  const cookie = `${ACCESS_COOKIE}=${accessToken}`;
  const lockedRequest = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    locked.app.request(`http://127.0.0.1:${PORT}${path}`, { method: init.method ?? "GET", headers: { host: trusted.host, ...init.headers }, body: init.body ? JSON.stringify(init.body) : undefined });

  afterAll(() => locked.close());

  it("refuses an API read and a write without the key", async () => {
    const read = await lockedRequest("/api/boards");
    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ error: "Access key missing" });
    const write = await lockedRequest("/api/commands", { method: "POST", headers: trusted, body: { type: "createBoard" } });
    expect(write.status).toBe(401);
  });

  it("shows a locked page instead of the app", async () => {
    const page = await lockedRequest("/");
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("locked");
  });

  it("refuses a wrong key and a cookie of the wrong value", async () => {
    expect((await lockedRequest(`/?${ACCESS_QUERY}=${"cd".repeat(32)}`)).status).toBe(401);
    expect((await lockedRequest("/api/boards", { headers: { cookie: `${ACCESS_COOKIE}=wrong` } })).status).toBe(401);
    expect((await lockedRequest("/api/boards", { headers: { cookie: `other=${accessToken}` } })).status).toBe(401);
  });

  it("turns the key in the link into a strict cookie and removes it from the address", async () => {
    const response = await lockedRequest(`/some/page?${ACCESS_QUERY}=${accessToken}&board=1`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/some/page?board=1");
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${ACCESS_COOKIE}=${accessToken}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("does not let a crafted path turn the redirect into another site", async () => {
    const response = await lockedRequest(`//evil.example/x?${ACCESS_QUERY}=${accessToken}`);
    expect(response.headers.get("location")?.startsWith("//")).toBe(false);
  });

  it("does not accept the key in the link on a write", async () => {
    const response = await lockedRequest(`/api/commands?${ACCESS_QUERY}=${accessToken}`, { method: "POST", headers: trusted, body: { type: "createBoard" } });
    expect(response.status).toBe(401);
  });

  it("serves the API with the cookie and still checks the origin on writes", async () => {
    expect((await lockedRequest("/api/boards", { headers: { cookie } })).status).toBe(200);
    const foreign = await lockedRequest("/api/commands", { method: "POST", headers: { ...trusted, cookie, origin: "http://evil.example" }, body: { type: "undo", boardId } });
    expect(foreign.status).toBe(403);
  });

  it("checks the host before the key", async () => {
    expect((await lockedRequest("/api/boards", { headers: { host: "evil.example:80", cookie } })).status).toBe(403);
  });

  it("leaves the agent approvals endpoint to its own per-run secret", async () => {
    const response = await lockedRequest("/mcp/not-a-live-secret", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" } });
    expect(response.status).toBe(404);
  });

  it("applies the key to the live event socket", () => {
    const config = { port: PORT, extraOrigins: [], accessToken };
    const upgrade = (headers: Record<string, string>) => ({ headers: { host: trusted.host, origin: trusted.origin, ...headers } }) as IncomingMessage;
    expect(isUpgradeAllowed(config, upgrade({}))).toBe(false);
    expect(isUpgradeAllowed(config, upgrade({ cookie: `${ACCESS_COOKIE}=nope` }))).toBe(false);
    expect(isUpgradeAllowed(config, upgrade({ cookie }))).toBe(true);
    expect(isUpgradeAllowed({ ...config, accessToken: undefined }, upgrade({}))).toBe(true);
  });

  it("keeps one key across restarts", () => {
    const path = join(directory, "keys", "access-token");
    const first = loadAccessToken(path);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(loadAccessToken(path)).toBe(first);
    writeFileSync(path, "not a key");
    expect(loadAccessToken(path)).not.toBe("not a key");
  });

  it("reads one cookie out of several", () => {
    expect(cookieValueOf(`a=1; ${ACCESS_COOKIE}=${accessToken}; b=2`, ACCESS_COOKIE)).toBe(accessToken);
    expect(cookieValueOf(undefined, ACCESS_COOKIE)).toBeUndefined();
  });
});

describe("importing a board shared by someone else", () => {
  let sharedBoardId = "";

  beforeAll(async () => {
    sharedBoardId = (await command({ type: "createBoard", title: "Shared", workspacePath: process.cwd(), mode: "fake" })).json.id;
    const first = (await command({ type: "reply", boardId: sharedBoardId, prompt: "first", run: false })).json.nodeId;
    await command({ type: "reply", boardId: sharedBoardId, parentIds: [first], prompt: "second", run: false });
  });

  const exportOf = async () => JSON.parse((await request(`/api/boards/${sharedBoardId}/export`)).text);
  const projectOf = async () => ((await view(sharedBoardId)).board as { projectId: string }).projectId;

  it("needs a project to import into", async () => {
    const response = await command({ type: "importBoard", raw: (await request(`/api/boards/${sharedBoardId}/export`)).text });
    expect(response.status).toBe(409);
    expect((await command({ type: "importBoard", projectId: "missing", raw: "{}" })).status).toBe(409);
  });

  it("uses the folder and runtime of the chosen project, not the file's", async () => {
    const document = await exportOf();
    Object.assign(document.board, { workspacePath: directory, mode: "claude", defaultAgent: "evil", budgetTokens: 1 });
    const imported = (await command({ type: "importBoard", projectId: await projectOf(), raw: JSON.stringify(document) })).json;
    const original = (await view(sharedBoardId)).board as { workspacePath: string; mode: string };
    expect(imported.workspacePath).toBe(original.workspacePath);
    expect(imported.mode).toBe(original.mode);
    expect(imported.defaultAgent).not.toBe("evil");
    expect(imported.budgetTokens).toBeUndefined();
    expect(((await request("/api/projects")).json as { workspacePath: string }[]).some((project) => project.workspacePath === directory)).toBe(false);
  });

  it("strips run choices from imported nodes", async () => {
    const document = await exportOf();
    Object.assign(document.nodes[0], { permissionMode: "dontAsk", agent: "build" });
    const imported = (await command({ type: "importBoard", projectId: await projectOf(), raw: JSON.stringify(document) })).json;
    const nodes = Object.values((await view(imported.id)).graph.nodes);
    expect(nodes.every((node) => node.permissionMode === undefined && node.agent === undefined)).toBe(true);
  });

  it("refuses a file whose connections loop", async () => {
    const document = await exportOf();
    const edge = document.edges[0];
    document.edges.push({ ...edge, fromId: edge.toId, toId: edge.fromId });
    expect((await command({ type: "importBoard", projectId: await projectOf(), raw: JSON.stringify(document) })).status).toBe(409);
  });

  it("refuses pasted nodes that are malformed", async () => {
    const response = await command({ type: "pasteNodes", boardId, clipboard: { format: "branchboard-nodes", version: 1, nodes: [{ id: "x", status: "bogus" }], edges: [], parts: [] } });
    expect(response.status).toBe(409);
  });
});

describe("the exit demo", () => {
  const ids: Record<string, string> = {};

  it("asks two separate questions", async () => {
    ids.A = (await command({ type: "reply", boardId, prompt: "question about apples" })).json.nodeId;
    ids.B = (await command({ type: "reply", boardId, prompt: "question about bananas" })).json.nodeId;
    await waitForStatus(boardId, ids.A, "done");
    await waitForStatus(boardId, ids.B, "done");
    expect(await textOf(boardId, ids.A)).toContain("question about apples");
  });

  it("wires A and B into C and C answers using both", async () => {
    ids.C = (await command({ type: "reply", boardId, parentIds: [ids.A], prompt: "" })).json.nodeId;
    expect((await command({ type: "connect", boardId, fromId: ids.B, toId: ids.C })).status).toBe(200);
    await command({ type: "run", boardId, nodeId: ids.C, prompt: "combine them" });
    await waitForStatus(boardId, ids.C, "done");
    const answer = await textOf(boardId, ids.C);
    expect(answer).toContain("question about apples");
    expect(answer).toContain("question about bananas");
    const node = await nodeOf(boardId, ids.C);
    expect(node.contextMode).toBe("injected");
    expect(node.runtimeRef?.sessionId).toBeTruthy();
  });

  it("the context preview matches what the model was given", async () => {
    const preview = (await request(`/api/nodes/${ids.C}/context?board=${boardId}`)).json;
    const nodeA = await nodeOf(boardId, ids.A);
    expect(preview.turns.map((turn: { nodeId: string }) => turn.nodeId)).toEqual((await nodeOf(boardId, ids.C)).contextNodeIds);
    expect(nodeA.status).toBe("done");
  });

  it("refuses a cycle with a reason", async () => {
    const response = await command({ type: "connect", boardId, fromId: ids.C, toId: ids.A });
    expect(response.status).toBe(409);
    expect(response.json.error).toMatch(/cycle/);
  });

  it("disconnecting B marks C stale", async () => {
    const graph = (await view(boardId)).graph;
    const edge = liveEdges(graph).find((candidate) => candidate.fromId === ids.B && candidate.toId === ids.C)!;
    await command({ type: "disconnect", boardId, edgeId: edge.id });
    const after = (await view(boardId)).graph;
    expect(isStale(after, after.nodes[ids.C])).toBe(true);
  });

  it("undo restores the edge and redo removes it again", async () => {
    await command({ type: "undo", boardId });
    const restored = (await view(boardId)).graph;
    expect(liveEdges(restored).some((edge) => edge.fromId === ids.B && edge.toId === ids.C)).toBe(true);
    expect(isStale(restored, restored.nodes[ids.C])).toBe(false);
    await command({ type: "redo", boardId });
    const removed = (await view(boardId)).graph;
    expect(liveEdges(removed).some((edge) => edge.fromId === ids.B && edge.toId === ids.C)).toBe(false);
  });

  it("regenerating C with another model loses B's knowledge", async () => {
    ids.C2 = (await command({ type: "sibling", boardId, originalId: ids.C, agent: "plan", model: "fake/echo-large" })).json.nodeId;
    await waitForStatus(boardId, ids.C2, "done");
    const regenerated = await textOf(boardId, ids.C2);
    expect(regenerated).toContain("question about apples");
    expect(regenerated).not.toContain("question about bananas");
    expect(regenerated).toContain("fake plan/fake/echo-large");
  });

  it("an approval pauses the run until answered", async () => {
    ids.T = (await command({ type: "reply", boardId, parentIds: [ids.A], prompt: "/tool read the notes" })).json.nodeId;
    await waitForStatus(boardId, ids.T, "awaiting_approval");
    const open = Object.values((await view(boardId)).requests).filter((candidate) => candidate.status === "open");
    expect(open).toHaveLength(1);
    await command({ type: "answerRequest", boardId, requestId: open[0].id, answer: "once" });
    await waitForStatus(boardId, ids.T, "done");
    const tool = (await view(boardId)).parts[ids.T].find((part) => part.type === "tool");
    expect(tool?.meta?.status).toBe("done");
  });

  it("a question pauses the run and the answers reach the tool result", async () => {
    const askedId = (await command({ type: "reply", boardId, parentIds: [ids.A], prompt: "/ask pick fruit" })).json.nodeId;
    await waitForStatus(boardId, askedId, "awaiting_approval");
    const open = Object.values((await view(boardId)).requests).filter((candidate) => candidate.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0].kind).toBe("question");
    expect(open[0].questions).toHaveLength(2);
    await command({ type: "answerRequest", boardId, requestId: open[0].id, answer: encodeAnswers([["apple"], ["cream", "nuts"]]) });
    await waitForStatus(boardId, askedId, "done");
    const tool = (await view(boardId)).parts[askedId].find((part) => part.type === "tool");
    expect(tool?.meta?.status).toBe("done");
    expect(String(tool?.meta?.output)).toContain("apple");
  });

  it("dismissing a question finishes the tool as an error", async () => {
    const dismissedId = (await command({ type: "reply", boardId, parentIds: [ids.A], prompt: "/ask pick fruit" })).json.nodeId;
    await waitForStatus(boardId, dismissedId, "awaiting_approval");
    const open = Object.values((await view(boardId)).requests).filter((candidate) => candidate.status === "open");
    await command({ type: "answerRequest", boardId, requestId: open[0].id, answer: REJECTED_ANSWER });
    await waitForStatus(boardId, dismissedId, "done");
    const tool = (await view(boardId)).parts[dismissedId].find((part) => part.type === "tool");
    expect(tool?.meta?.status).toBe("error");
  });

  it("stop keeps the partial output and marks the node stopped", async () => {
    ids.S = (await command({ type: "reply", boardId, prompt: `/slow ${"count ".repeat(100)}` })).json.nodeId;
    await waitFor(async () => (await textOf(boardId, ids.S)).length > 10);
    await command({ type: "abort", boardId, nodeId: ids.S });
    await waitForStatus(boardId, ids.S, "done");
    const node = await nodeOf(boardId, ids.S);
    expect(node.stopped).toBe(true);
    expect((await textOf(boardId, ids.S)).length).toBeGreaterThan(0);
  });

  it("a finished node's prompt cannot be edited", async () => {
    const response = await command({ type: "editNode", boardId, nodeId: ids.A, fields: { prompt: "rewrite history" } });
    expect(response.status).toBe(409);
  });

  it("deleting with exclusive descendants removes the subtree and undo brings it back", async () => {
    await command({ type: "deleteNodes", boardId, ids: [ids.A], withExclusiveDescendants: true });
    const deleted = (await view(boardId)).graph;
    expect(deleted.nodes[ids.A].deleted).toBe(true);
    expect(deleted.nodes[ids.T].deleted).toBe(true);
    expect(deleted.nodes[ids.B].deleted).toBe(false);
    await command({ type: "undo", boardId });
    expect((await view(boardId)).graph.nodes[ids.A].deleted).toBe(false);
  });

  it("exports and imports the whole board", async () => {
    const exported = await request(`/api/boards/${boardId}/export`);
    expect(exported.status).toBe(200);
    const projectId = ((await view(boardId)).board as { projectId: string }).projectId;
    const imported = (await command({ type: "importBoard", projectId, raw: exported.text })).json;
    const copy = await view(imported.id);
    const original = await view(boardId);
    const liveCount = (graph: BoardView["graph"]) => Object.values(graph.nodes).filter((node) => !node.deleted).length;
    expect(liveCount(copy.graph)).toBe(liveCount(original.graph));
    expect(liveEdges(copy.graph)).toHaveLength(liveEdges(original.graph).length);
    const importedC = Object.values(copy.graph.nodes).find((node) => node.prompt === "combine them")!;
    expect(importedC).toBeTruthy();
    expect(answerText(copy.parts[importedC.id], activeRollOf(importedC))).toContain("question about bananas");
  });

  it("escapes survive: model output is stored as plain text", async () => {
    const xss = (await command({ type: "reply", boardId, prompt: "<img src=x onerror=alert(1)>" })).json.nodeId;
    await waitForStatus(boardId, xss, "done");
    expect(await textOf(boardId, xss)).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("scheduling", () => {
  const slowPrompt = (label: string) => `/slow ${label} ${"word ".repeat(40)}`;

  it("runs unconnected nodes in parallel and records elapsed time", async () => {
    const first = (await command({ type: "reply", boardId, prompt: slowPrompt("one") })).json.nodeId;
    const second = (await command({ type: "reply", boardId, prompt: slowPrompt("two") })).json.nodeId;
    await waitFor(async () => (await nodeOf(boardId, first)).status === "running" && (await nodeOf(boardId, second)).status === "running");
    await command({ type: "abort", boardId, nodeId: first });
    await command({ type: "abort", boardId, nodeId: second });
    await waitForStatus(boardId, first, "done");
    const finished = await nodeOf(boardId, first);
    expect(finished.completedAt! - finished.startedAt!).toBeGreaterThanOrEqual(0);
  });

  it("queues a connected node behind its running ancestor and locks the ancestor", async () => {
    const parent = (await command({ type: "reply", boardId, prompt: slowPrompt("parent") })).json.nodeId;
    await waitForStatus(boardId, parent, "running");
    const child = (await command({ type: "reply", boardId, parentIds: [parent], prompt: "follow up" })).json.nodeId;
    expect((await nodeOf(boardId, child)).status).toBe("queued");
    expect((await command({ type: "deleteNodes", boardId, ids: [parent] })).status).toBe(409);
    expect((await command({ type: "reply", boardId, parentIds: [parent], prompt: "" })).status).toBe(200);
    await command({ type: "abort", boardId, nodeId: parent });
    await waitForStatus(boardId, child, "done");
    expect((await command({ type: "regenerate", boardId, nodeId: child })).status).toBe(200);
    await waitForStatus(boardId, child, "done");
  });

  it("keeps regenerated answers as rolls and only the active one is shown and passed downstream", async () => {
    const parent = (await command({ type: "reply", boardId, prompt: "roll me" })).json.nodeId;
    await waitForStatus(boardId, parent, "done");
    const firstRoll = await textOf(boardId, parent);
    await command({ type: "regenerate", boardId, nodeId: parent });
    await waitForStatus(boardId, parent, "done");
    expect(await textOf(boardId, parent)).toBe(firstRoll);
    const storedParts = (await view(boardId)).parts[parent];
    expect(new Set(storedParts.map((part) => part.roll))).toEqual(new Set([1, 2]));
    const rolled = await nodeOf(boardId, parent);
    expect([rolled.activeRoll, rolled.rollCount, Object.keys(rolled.rolls ?? {})]).toEqual([2, 2, ["1"]]);
    const child = (await command({ type: "reply", boardId, parentIds: [parent], prompt: "follow" })).json.nodeId;
    await waitForStatus(boardId, child, "done");
    expect((await command({ type: "selectRoll", boardId, nodeId: parent, roll: 1 })).status).toBe(200);
    expect((await nodeOf(boardId, parent)).activeRoll).toBe(1);
    expect(isStale((await view(boardId)).graph, (await nodeOf(boardId, child)))).toBe(true);
    expect((await command({ type: "selectRoll", boardId, nodeId: parent, roll: 1 })).status).toBe(409);
  });

  it("writes the exact input of every run to the board's run log", async () => {
    const parent = (await command({ type: "reply", boardId, prompt: "logged parent" })).json.nodeId;
    await waitForStatus(boardId, parent, "done");
    const child = (await command({ type: "reply", boardId, parentIds: [parent], prompt: "logged child" })).json.nodeId;
    await waitForStatus(boardId, child, "done");
    const records = readFileSync(join(directory, "run-logs", `${boardId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const childStart = records.find((record) => record.event === "start" && record.nodeId === child);
    expect(childStart.prompt).toBe("logged child");
    expect(childStart.contextMode).toBe("exact");
    expect(childStart.forkedFrom.nodeId).toBe(parent);
    const childEnd = records.find((record) => record.event === "end" && record.nodeId === child);
    expect([childEnd.status, childEnd.roll]).toEqual(["done", 1]);
    const parentStart = records.find((record) => record.event === "start" && record.nodeId === parent);
    expect(parentStart.input).toBe("logged parent");
  });

  it("lists live runs until they are really over, whatever happens to the node", async () => {
    const runs = async () => (await request("/api/runs")).json as { boardId: string; nodeId: string; status: string; title: string }[];
    const parent = (await command({ type: "reply", boardId, prompt: slowPrompt("listed") })).json.nodeId;
    await waitForStatus(boardId, parent, "running");
    const child = (await command({ type: "reply", boardId, parentIds: [parent], prompt: "waits behind it" })).json.nodeId;
    const listed = await runs();
    expect(listed.find((run) => run.nodeId === parent)?.status).toBe("running");
    expect(listed.find((run) => run.nodeId === child)?.status).toBe("queued");
    expect((await command({ type: "deleteNodes", boardId, ids: [parent] })).status).toBe(409);
    expect((await runs()).some((run) => run.nodeId === parent)).toBe(true);
    await command({ type: "abort", boardId, nodeId: parent });
    await waitFor(async () => !(await runs()).some((run) => run.nodeId === parent));
    await waitForStatus(boardId, child, "done");
    expect((await runs()).some((run) => run.nodeId === child)).toBe(false);
  });

  it("a new reply inherits its parent's model", async () => {
    const parent = (await command({ type: "reply", boardId, prompt: "pick", model: "fake/echo-large" })).json.nodeId;
    await waitForStatus(boardId, parent, "done");
    const child = (await command({ type: "reply", boardId, parentIds: [parent], prompt: "" })).json.nodeId;
    expect((await nodeOf(boardId, child)).model).toBe("fake/echo-large");
  });
});

describe("attachments", () => {
  const upload = async (name: string, content: string, type: string) => {
    const response = await server.app.request(`http://127.0.0.1:${PORT}/api/boards/${boardId}/attachments?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...trusted, "content-type": type }, body: content });
    return { status: response.status, json: await response.json() };
  };

  it("stores an upload and serves it back without letting it run as a page", async () => {
    const stored = await upload("page.html", "<script>alert(1)</script>", "text/html");
    expect(stored.status).toBe(200);
    const served = await server.app.request(`http://127.0.0.1:${PORT}/api/attachments/${stored.json.id}`, { headers: { host: trusted.host } });
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(await served.text()).toContain("alert(1)");
  });

  it("extracts a text attachment into an unconnected code node and refuses binary ones", async () => {
    const stored = await upload("snippet.py", "print('hi')", "text/x-python");
    const fileNode = (await command({ type: "file", boardId, attachmentIds: [stored.json.id] })).json.nodeId;
    const extracted = await command({ type: "extractAttachment", boardId, attachmentId: stored.json.id, originId: fileNode });
    const { graph } = await view(boardId);
    expect(graph.nodes[extracted.json.nodeId]).toMatchObject({ kind: "code", title: "snippet.py", filePath: "snippet.py", prompt: "print('hi')", sourceAttachmentId: stored.json.id });
    expect(liveEdges(graph).some((edge) => edge.toId === extracted.json.nodeId)).toBe(false);
    const binary = await upload("blob.bin", "a\0b", "application/octet-stream");
    expect((await command({ type: "extractAttachment", boardId, attachmentId: binary.json.id })).status).toBe(409);
  });

  it("refuses an unknown attachment id and an empty file", async () => {
    expect((await command({ type: "file", boardId, attachmentIds: ["../../secret"] })).status).toBe(409);
    expect((await upload("empty.txt", "", "text/plain")).status).toBe(409);
  });

  it("a file node feeds a chat its attachment, and a bound attachment reaches the model", async () => {
    const stored = await upload("notes.txt", "remember the walrus", "text/plain");
    const fileNode = (await command({ type: "file", boardId, attachmentIds: [stored.json.id] })).json.nodeId;
    expect((await nodeOf(boardId, fileNode)).kind).toBe("file");
    const chat = (await command({ type: "reply", boardId, parentIds: [fileNode], prompt: "what is in the file?" })).json.nodeId;
    await waitForStatus(boardId, chat, "done");
    expect(await textOf(boardId, chat)).toContain("notes.txt");

    const bound = await upload("photo.png", "not really a png", "image/png");
    const draft = (await command({ type: "reply", boardId, prompt: "" })).json.nodeId;
    expect((await command({ type: "attach", boardId, nodeId: draft, attachmentIds: [bound.json.id] })).status).toBe(200);
    await command({ type: "run", boardId, nodeId: draft, prompt: "describe the picture" });
    await waitForStatus(boardId, draft, "done");
    expect(await textOf(boardId, draft)).toContain("describe the picture");
    expect((await command({ type: "attach", boardId, nodeId: draft, attachmentIds: [bound.json.id] })).status).toBe(409);
  });
});

describe("projects and boards", () => {
  const projects = async () => (await request("/api/projects")).json as { id: string; name: string; workspacePath: string }[];
  const boardList = async () => (await request("/api/boards")).json as { id: string; projectId: string; title: string; deleted: boolean }[];

  it("groups boards created for the same folder under one project", async () => {
    const before = (await projects()).length;
    const first = (await command({ type: "createBoard", workspacePath: process.cwd(), mode: "fake" })).json;
    const second = (await command({ type: "createBoard", workspacePath: process.cwd(), mode: "fake" })).json;
    expect(first.projectId).toBe(second.projectId);
    expect(first.title).toBe("Untitled board");
    expect((await projects()).length).toBe(before);
  });

  it("creates several boards for a connected project and deletes them with it", async () => {
    const folder = mkdtempSync(join(tmpdir(), "branchboard-project-"));
    const project = (await command({ type: "createProject", workspacePath: folder, mode: "fake", name: "Side project" })).json;
    expect(project.name).toBe("Side project");
    const boards = [(await command({ type: "createBoard", projectId: project.id, title: "One" })).json, (await command({ type: "createBoard", projectId: project.id })).json];
    expect((await boardList()).filter((board) => board.projectId === project.id)).toHaveLength(2);
    expect((await command({ type: "renameProject", projectId: project.id, name: "Renamed" })).status).toBe(200);
    expect((await projects()).find((candidate) => candidate.id === project.id)?.name).toBe("Renamed");
    expect((await command({ type: "deleteProject", projectId: project.id })).status).toBe(200);
    expect((await projects()).some((candidate) => candidate.id === project.id)).toBe(false);
    expect((await boardList()).some((board) => boards.some((created) => created.id === board.id))).toBe(false);
    rmSync(folder, { recursive: true, force: true });
  });

  it("saves a board on demand", async () => {
    const saved = await command({ type: "saveNow", boardId });
    expect(saved.status).toBe(200);
    expect(saved.json.savedAt).toBeGreaterThan(0);
  });

  it("refuses a missing folder and an unknown project", async () => {
    expect((await command({ type: "createProject", workspacePath: join(tmpdir(), "does-not-exist-bb"), mode: "fake" })).status).toBe(409);
    expect((await command({ type: "createBoard", projectId: "nope" })).status).toBe(409);
  });
});

describe("crash recovery", () => {
  it("marks running nodes interrupted and keeps their partial text", async () => {
    const crashing = (await command({ type: "reply", boardId, prompt: `/slow ${"crash ".repeat(100)}` })).json.nodeId;
    await waitFor(async () => (await textOf(boardId, crashing)).length > 20);
    await new Promise((resolve) => setTimeout(resolve, 400));
    server.close();
    server = createApp({ databasePath, security, webRoot: join(directory, "none") });
    const node = await nodeOf(boardId, crashing);
    expect(node.status).toBe("interrupted");
    expect((await textOf(boardId, crashing)).length).toBeGreaterThan(20);
  });
});

describe("files that may hold secrets", () => {
  const folder = mkdtempSync(join(tmpdir(), "branchboard-secrets-"));
  let secretsBoard = "";

  beforeAll(async () => {
    mkdirSync(join(folder, ".git"));
    writeFileSync(join(folder, ".git", "config"), "[core]");
    writeFileSync(join(folder, ".env"), "TOKEN=abc");
    writeFileSync(join(folder, "server.pem"), "-----BEGIN PRIVATE KEY-----");
    writeFileSync(join(folder, "notes.md"), "# notes");
    secretsBoard = (await command({ type: "createBoard", workspacePath: folder, mode: "fake" })).json.id;
  });

  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  const reply = (prompt: string, extra: Record<string, unknown> = {}) => command({ type: "reply", boardId: secretsBoard, parentIds: [], prompt, ...extra });

  it("asks before a prompt that mentions a secret file is sent", async () => {
    const refused = await reply("summarise @.env please");
    expect(refused.status).toBe(409);
    expect(refused.json.sensitiveFiles).toEqual([".env"]);
    expect(Object.keys((await view(secretsBoard)).graph.nodes)).toHaveLength(0);
  });

  it("goes ahead once the user has confirmed", async () => {
    const accepted = await reply("summarise @server.pem", { allowSensitive: true });
    expect(accepted.status).toBe(200);
    expect(accepted.json.nodeId).toBeTruthy();
  });

  it("does not ask for ordinary files or for a mention of a file that does not exist", async () => {
    expect((await reply("read @notes.md")).status).toBe(200);
    expect((await reply("read @missing.env")).status).toBe(200);
  });

  it("asks again when a node with such a mention is regenerated", async () => {
    const nodeId = (await reply("look at @.env", { allowSensitive: true })).json.nodeId;
    await waitForStatus(secretsBoard, nodeId, "done");
    const refused = await command({ type: "regenerate", boardId: secretsBoard, nodeId });
    expect(refused.status).toBe(409);
    expect((await command({ type: "regenerate", boardId: secretsBoard, nodeId, allowSensitive: true })).status).toBe(200);
  });

  it("asks before a secret file is extracted into a node", async () => {
    expect((await command({ type: "extractFile", boardId: secretsBoard, path: ".env" })).json.sensitiveFiles).toEqual([".env"]);
    expect((await command({ type: "extractFile", boardId: secretsBoard, path: ".git/config" })).status).toBe(409);
    expect((await command({ type: "extractFile", boardId: secretsBoard, path: ".env", allowSensitive: true })).status).toBe(200);
    expect((await command({ type: "extractFile", boardId: secretsBoard, path: "notes.md" })).status).toBe(200);
  });

  it("asks before a secret file is attached to a node", async () => {
    const upload = await server.app.request(`http://127.0.0.1:${PORT}/api/boards/${secretsBoard}/attachments?name=${encodeURIComponent("prod.env")}`, { method: "POST", headers: { ...trusted, "content-type": "text/plain" }, body: "A=1" });
    const stored = await upload.json();
    const keyUpload = await server.app.request(`http://127.0.0.1:${PORT}/api/boards/${secretsBoard}/attachments?name=${encodeURIComponent(".env.local")}`, { method: "POST", headers: { ...trusted, "content-type": "text/plain" }, body: "A=1" });
    const keyStored = await keyUpload.json();
    expect((await command({ type: "file", boardId: secretsBoard, attachmentIds: [keyStored.id] })).json.sensitiveFiles).toEqual([".env.local"]);
    expect((await command({ type: "file", boardId: secretsBoard, attachmentIds: [stored.id] })).status).toBe(200);
    expect((await command({ type: "file", boardId: secretsBoard, attachmentIds: [keyStored.id], allowSensitive: true })).status).toBe(200);
  });

  it("keeps secret files out of the mention suggestions but not out of the file route", async () => {
    const suggestions = (await request(`/api/workspace/files?board=${secretsBoard}&q=`)).json as string[];
    expect(suggestions).toEqual(["notes.md"]);
    const served = await server.app.request(`http://127.0.0.1:${PORT}/api/boards/${secretsBoard}/files?path=${encodeURIComponent(".env")}`, { headers: { host: trusted.host } });
    expect(served.status).toBe(200);
  });
});

describe("workspace files", () => {
  const folder = mkdtempSync(join(tmpdir(), "branchboard-files-"));
  const outside = mkdtempSync(join(tmpdir(), "branchboard-outside-"));
  let filesBoard = "";

  beforeAll(async () => {
    mkdirSync(join(folder, "out"));
    writeFileSync(join(folder, "out", "report.html"), "<script>1</script><h1>Report</h1>");
    writeFileSync(join(folder, "notes.md"), "# notes");
    writeFileSync(join(folder, "data.bin"), "bytes");
    writeFileSync(join(outside, "secret.txt"), "secret");
    filesBoard = (await command({ type: "createBoard", workspacePath: folder, mode: "fake" })).json.id;
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const open = (path: string) => server.app.request(`http://127.0.0.1:${PORT}/api/boards/${filesBoard}/files?path=${encodeURIComponent(path)}`, { headers: { host: trusted.host } });

  it("serves an html file as a page that runs scripts without the app's origin", async () => {
    const response = await open("out/report.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(await response.text()).toContain("Report");
  });

  it("accepts an absolute path inside the folder", async () => {
    expect((await open(join(folder, "notes.md"))).status).toBe(200);
  });

  it("shows text inline as plain text and downloads unknown types", async () => {
    const text = await open("notes.md");
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(text.headers.get("content-disposition")).toContain("inline");
    expect((await open("data.bin")).headers.get("content-disposition")).toContain("attachment");
  });

  it("refuses paths outside the folder, missing files and directories", async () => {
    expect((await open("../" + join(outside, "secret.txt").split(/[\/]/).slice(-2).join("/"))).status).toBe(409);
    expect((await open(join(outside, "secret.txt"))).status).toBe(409);
    expect((await open("missing.html")).status).toBe(409);
    expect((await open("out")).status).toBe(409);
  });

  it("extracts a workspace file into a code node beside its origin", async () => {
    const extracted = await command({ type: "extractFile", boardId: filesBoard, path: join(folder, "out", "report.html") });
    expect(extracted.status).toBe(200);
    const { graph } = await view(filesBoard);
    const node = graph.nodes[extracted.json.nodeId];
    expect(node).toMatchObject({ kind: "code", title: "report.html", filePath: "out/report.html", prompt: "<script>1</script><h1>Report</h1>" });
  });

  it("connects an extracted code node to the node it came from", async () => {
    const origin = await command({ type: "reply", boardId: filesBoard, prompt: "see notes.md", run: false });
    const extracted = await command({ type: "extractFile", boardId: filesBoard, path: "notes.md", originId: origin.json.nodeId });
    const { graph } = await view(filesBoard);
    expect(liveEdges(graph).some((edge) => edge.fromId === origin.json.nodeId && edge.toId === extracted.json.nodeId)).toBe(true);
  });

  it("writes an edited code node back to its workspace file", async () => {
    writeFileSync(join(folder, "edit-me.md"), "# Old");
    const extracted = await command({ type: "extractFile", boardId: filesBoard, path: "edit-me.md" });
    const saved = await command({ type: "writeCodeFile", boardId: filesBoard, nodeId: extracted.json.nodeId, content: "# New" });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(folder, "edit-me.md"), "utf8")).toBe("# New");
    expect((await view(filesBoard)).graph.nodes[extracted.json.nodeId].prompt).toBe("# New");
  });

  it("refuses to write a code node that is not a workspace file", async () => {
    const spawned = await command({ type: "code", boardId: filesBoard });
    expect((await command({ type: "writeCodeFile", boardId: filesBoard, nodeId: spawned.json.nodeId, content: "x" })).status).toBe(409);
  });

  it("refuses to extract files outside the folder, missing files and binary files", async () => {
    writeFileSync(join(folder, "blob.ts"), "a\0b");
    expect((await command({ type: "extractFile", boardId: filesBoard, path: join(outside, "secret.txt") })).status).toBe(409);
    expect((await command({ type: "extractFile", boardId: filesBoard, path: "missing.ts" })).status).toBe(409);
    expect((await command({ type: "extractFile", boardId: filesBoard, path: "blob.ts" })).status).toBe(409);
  });

  it("spawns an empty code node and fills it with a chosen workspace file", async () => {
    const spawned = await command({ type: "code", boardId: filesBoard });
    expect(spawned.status).toBe(200);
    expect((await view(filesBoard)).graph.nodes[spawned.json.nodeId]).toMatchObject({ kind: "code", title: "Code", prompt: "" });
    const opened = await command({ type: "openFile", boardId: filesBoard, nodeId: spawned.json.nodeId, path: "notes.md" });
    expect(opened.status).toBe(200);
    expect((await view(filesBoard)).graph.nodes[spawned.json.nodeId]).toMatchObject({ kind: "code", title: "notes.md", filePath: "notes.md" });
  });

  it("refuses to open files outside the folder into a code node", async () => {
    const spawned = await command({ type: "code", boardId: filesBoard });
    expect((await command({ type: "openFile", boardId: filesBoard, nodeId: spawned.json.nodeId, path: join(outside, "secret.txt") })).status).toBe(409);
  });

  it("refuses to reveal files outside the folder", async () => {
    expect((await command({ type: "revealFile", boardId: filesBoard, path: join(outside, "secret.txt") })).status).toBe(409);
  });

  it("feeds a code node's text to a child as context", async () => {
    const extracted = await command({ type: "extractFile", boardId: filesBoard, path: "notes.md" });
    const child = await command({ type: "reply", boardId: filesBoard, parentIds: [extracted.json.nodeId], prompt: "what is this", run: false });
    expect(child.status).toBe(200);
  });

  it("refreshes a code node when its file changes, without an undo step", async () => {
    writeFileSync(join(folder, "live.ts"), "const one = 1;");
    const extracted = await command({ type: "extractFile", boardId: filesBoard, path: "live.ts" });
    const nodeId = extracted.json.nodeId;
    server.codeFileSync.syncAll();
    expect((await view(filesBoard)).graph.nodes[nodeId].prompt).toBe("const one = 1;");
    writeFileSync(join(folder, "live.ts"), "const two = 22222;");
    server.codeFileSync.syncAll();
    expect((await view(filesBoard)).graph.nodes[nodeId].prompt).toBe("const two = 22222;");
    expect(server.boards.stateOf(filesBoard).undoStack.some((patch) => patch.nodes[nodeId]?.prompt === "const one = 1;")).toBe(false);
  });
});
