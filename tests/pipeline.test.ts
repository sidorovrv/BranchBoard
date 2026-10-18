import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BoardView, GraphNode } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { createLimiter } from "../packages/server/src/run/limiter";
import { fakeRuntime } from "../packages/server/src/runtimes/fake";
import type { RuntimeSteps } from "../packages/server/src/run/types";

const PORT = 47124;
const trusted = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
const directory = mkdtempSync(join(tmpdir(), "branchboard-pipeline-"));

const slots = createLimiter(1);
const dropped: string[] = [];
const seenRuns: { input: string; contextNote?: string }[] = [];
let concurrentSlowRuns = 0;
let busiestSlowRuns = 0;

const scripted: RuntimeSteps<any, any> = {
  ...fakeRuntime,
  slots,
  rejectClosesRun: true,
  dropSession: async (reference) => void dropped.push(reference.sessionId),
  openSession: async (plan, scope) => ({ ...(await fakeRuntime.openSession(plan, scope)), sessionId: `fake-${scope.nodeId}-${randomUUID()}` }),
  catalog: async (workspacePath) => ({
    ...(await fakeRuntime.catalog(workspacePath)),
    commands: [{ name: "review", description: "Review something", template: "Please review: $ARGUMENTS" }, { name: "pass", description: "Runs alone", template: "", passThrough: true }],
  }),
  execute: async function* (session, input, scope) {
    seenRuns.push({ input, contextNote: scope.contextNote });
    const prompt = input.split("\n").at(-1) ?? "";
    if (prompt.startsWith("/slow")) {
      concurrentSlowRuns++;
      busiestSlowRuns = Math.max(busiestSlowRuns, concurrentSlowRuns);
      try {
        yield* fakeRuntime.execute(session, input, scope);
      } finally {
        concurrentSlowRuns--;
      }
      return;
    }
    if (prompt.startsWith("/two")) {
      scope.setRuntimeRef({ sessionId: session.sessionId });
      yield { type: "approval", id: "first", title: "First approval" };
      yield { type: "approval", id: "second", title: "Second approval" };
      await scope.waitForAnswer("first");
      yield { type: "chunk", text: "finished" };
      return;
    }
    yield* fakeRuntime.execute(session, input, scope);
  },
};

let server: ReturnType<typeof createApp>;
let boardId = "";

const request = async (path: string, body?: unknown) => {
  const response = await server.app.request(`http://127.0.0.1:${PORT}${path}`, { method: body ? "POST" : "GET", headers: trusted, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
};

const command = (body: Record<string, unknown>) => request("/api/commands", body);
const view = async (): Promise<BoardView> => (await request(`/api/boards/${boardId}/graph`)).json;
const nodeOf = async (nodeId: string): Promise<GraphNode> => (await view()).graph.nodes[nodeId];

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
};

const waitForStatus = (nodeId: string, status: string) => waitFor(async () => (await nodeOf(nodeId)).status === status);

beforeAll(async () => {
  server = createApp({
    databasePath: join(directory, "pipeline.db"),
    security: { port: PORT, extraOrigins: [] },
    webRoot: join(directory, "none"),
    runtimes: { fake: scripted, opencode: fakeRuntime, claude: fakeRuntime },
  });
  boardId = (await command({ type: "createBoard", title: "Pipeline", workspacePath: process.cwd(), mode: "fake" })).json.id;
});

afterAll(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("run slots", () => {
  it("lets one run use the slot at a time and releases it afterwards", async () => {
    const first = (await command({ type: "reply", boardId, prompt: "/slow one" })).json.nodeId;
    const second = (await command({ type: "reply", boardId, prompt: "/slow two" })).json.nodeId;
    await waitForStatus(first, "done");
    await waitForStatus(second, "done");
    expect(busiestSlowRuns).toBe(1);
    expect(slots.activeCount()).toBe(0);
    expect(slots.waitingCount()).toBe(0);
  });
});

describe("pass-through commands", () => {
  it("send only the command and carry the missing ancestor turns in the context note", async () => {
    const left = (await command({ type: "reply", boardId, prompt: "left branch fact" })).json.nodeId;
    const right = (await command({ type: "reply", boardId, prompt: "right branch fact" })).json.nodeId;
    await waitForStatus(left, "done");
    await waitForStatus(right, "done");
    const child = (await command({ type: "reply", boardId, parentIds: [left], prompt: "" })).json.nodeId;
    await command({ type: "connect", boardId, fromId: right, toId: child });
    seenRuns.length = 0;
    await command({ type: "run", boardId, nodeId: child, prompt: "/pass the arguments" });
    await waitForStatus(child, "done");
    const run = seenRuns.at(-1)!;
    expect(run.input).toBe("/pass the arguments");
    expect(run.contextNote).toContain("right branch fact");
  });
});

describe("rejecting an approval", () => {
  it("closes the other open approvals of the run when the runtime asks for it", async () => {
    const nodeId = (await command({ type: "reply", boardId, prompt: "/two approvals" })).json.nodeId;
    await waitFor(async () => Object.values((await view()).requests).filter((candidate) => candidate.status === "open").length === 2);
    const [first] = Object.values((await view()).requests).filter((candidate) => candidate.title === "First approval");
    await command({ type: "answerRequest", boardId, requestId: first.id, answer: "reject" });
    await waitForStatus(nodeId, "done");
    const requests = Object.values((await view()).requests).filter((candidate) => candidate.nodeId === nodeId);
    expect(requests.map((candidate) => [candidate.status, candidate.answer])).toEqual([["closed", "reject"], ["closed", "reject"]]);
  });
});

describe("trash purge", () => {
  it("drops the runtime sessions of a purged node", async () => {
    const nodeId = (await command({ type: "reply", boardId, prompt: "to be purged" })).json.nodeId;
    await waitForStatus(nodeId, "done");
    const sessionId = (await nodeOf(nodeId)).runtimeRef!.sessionId;
    await command({ type: "deleteNodes", boardId, ids: [nodeId] });
    expect(dropped).not.toContain(sessionId);
    await command({ type: "emptyTrash" });
    expect(dropped).toContain(sessionId);
  });
});

describe("discarded rolls", () => {
  it("drops the sessions of rolls that a prompt edit discarded once undo cannot restore them", async () => {
    const nodeId = (await command({ type: "reply", boardId, prompt: "first answer" })).json.nodeId;
    await waitForStatus(nodeId, "done");
    const firstSession = (await nodeOf(nodeId)).runtimeRef!.sessionId;
    await command({ type: "regenerate", boardId, nodeId });
    await waitFor(async () => (await nodeOf(nodeId)).rollCount === 2 && (await nodeOf(nodeId)).status === "done");
    const secondSession = (await nodeOf(nodeId)).runtimeRef!.sessionId;
    expect(secondSession).not.toBe(firstSession);
    await command({ type: "reopen", boardId, nodeId });
    await command({ type: "editNode", boardId, nodeId, fields: { prompt: "second prompt" } });
    await command({ type: "emptyTrash" });
    expect(dropped).not.toContain(firstSession);
    const other = (await command({ type: "reply", boardId, prompt: "to be purged too" })).json.nodeId;
    await waitForStatus(other, "done");
    await command({ type: "deleteNodes", boardId, ids: [other] });
    await command({ type: "emptyTrash" });
    expect(dropped).toContain(firstSession);
    expect(dropped).not.toContain(secondSession);
  });
});
