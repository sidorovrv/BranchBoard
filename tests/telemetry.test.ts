import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDailyPayload, type DailyPayload } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { createUsage } from "../packages/server/src/usage";
import { appClient, waitFor } from "./support";

const PORT = 47193;

const directory = mkdtempSync(join(tmpdir(), "branchboard-telemetry-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const atNoon = (day: string) => new Date(`${day}T12:00:00`).getTime();

interface Harness {
  server: ReturnType<typeof createApp>;
  boardId: string;
  posts: { url: string; payload: DailyPayload }[];
  respondWith: { status: number | "fail" };
  clock: { now: number };
  command: (body: Record<string, unknown>) => Promise<any>;
  get: (path: string) => Promise<any>;
  dataDirectory: string;
  restart: () => Promise<void>;
}

const harness = async (name: string, startDay = "2026-10-10"): Promise<Harness> => {
  const dataDirectory = join(directory, name);
  const posts: Harness["posts"] = [];
  const respondWith: Harness["respondWith"] = { status: 204 };
  const clock = { now: atNoon(startDay) };
  const open = () =>
    createApp({
      databasePath: join(dataDirectory, "test.db"),
      security: { port: PORT, extraOrigins: [] },
      clock: () => clock.now,
      telemetryPost: async (url, body) => {
        posts.push({ url, payload: JSON.parse(body) });
        if (respondWith.status === "fail") throw new Error("network down");
        return { status: respondWith.status };
      },
    });
  mkdirSync(dataDirectory, { recursive: true });
  const state = { server: open() };
  const client = appClient(() => state.server, PORT);
  const request = async (path: string, body?: unknown) => (await client.request(path, body)).json;
  const result: Harness = {
    get server() {
      return state.server;
    },
    boardId: "",
    posts,
    respondWith,
    clock,
    command: (body) => request("/api/commands", body),
    get: request,
    dataDirectory,
    restart: async () => {
      state.server.close();
      state.server = open();
    },
  } as Harness;
  result.boardId = (await result.command({ type: "createBoard", title: "Stats", workspacePath: process.cwd(), mode: "fake" })).id;
  return result;
};

const finishRun = async (h: Harness, prompt: string) => {
  const { nodeId } = await h.command({ type: "reply", boardId: h.boardId, prompt });
  await waitFor(async () => ["done", "error"].includes((await h.get(`/api/boards/${h.boardId}/graph`)).graph.nodes[nodeId].status));
  await waitFor(() => h.server.runs.listRuns().length === 0);
  return nodeId;
};

const telemetryFile = (h: Harness) => JSON.parse(readFileSync(join(h.dataDirectory, "telemetry.json"), "utf8"));

describe("usage counting", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness("counting");
  });
  afterAll(() => h.server.close());

  it("records runs, node kinds, boards and undo steps in the day ledger and counts only successful runs in telemetry.json", async () => {
    await finishRun(h, "hello");
    await finishRun(h, "/fail");
    await h.command({ type: "note", boardId: h.boardId, prompt: "a note" });
    await h.command({ type: "undo", boardId: h.boardId });
    const day = h.server.usage.ledger().days["2026-10-10"];
    expect(day.runs).toMatchObject({ started: 2, done: 1, error: 1, byRuntime: { fake: 2 } });
    expect(day.nodesCreated).toEqual({ reply: 2, note: 1 });
    expect(day.boardsCreated).toBe(1);
    expect(day.undo).toBe(1);
    expect(day.activeBoardIds).toEqual([h.boardId]);
    expect(telemetryFile(h).successfulRuns).toBe(1);
  });

  it("counts a regeneration", async () => {
    const nodeId = await finishRun(h, "again");
    await h.command({ type: "regenerate", boardId: h.boardId, nodeId });
    await waitFor(() => h.server.usage.ledger().days["2026-10-10"].runs.regenerations === 1);
  });

  it("keeps the ledger across a restart", async () => {
    const before = h.server.usage.ledger().days["2026-10-10"].runs.started;
    await h.restart();
    expect(h.server.usage.ledger().days["2026-10-10"].runs.started).toBe(before);
  });
});

describe("consent", () => {
  it("asks when the 25th successful run is done and not before", async () => {
    const h = await harness("asking");
    writeFileSync(join(h.dataDirectory, "telemetry.json"), JSON.stringify({ schema: 1, successfulRuns: 23, firstDay: "2026-10-01" }));
    await h.restart();
    await finishRun(h, "twenty-four");
    expect((await h.get("/api/telemetry")).shouldAsk).toBe(false);
    await finishRun(h, "twenty-five");
    const overview = await h.get("/api/telemetry");
    expect(overview).toMatchObject({ consent: null, shouldAsk: true });
    expect(isDailyPayload(overview.preview)).toBe(true);
    expect(overview.preview.runs.started).toBe(2);
    h.server.close();
  });

  it("stores the choice with its time and version across a restart", async () => {
    const h = await harness("deciding");
    await h.command({ type: "setTelemetryConsent", granted: true });
    expect(telemetryFile(h)).toMatchObject({ consent: "granted", decidedAt: atNoon("2026-10-10"), decidedInVersion: expect.any(String) });
    await h.restart();
    expect((await h.get("/api/telemetry")).consent).toBe("granted");
    await h.command({ type: "setTelemetryConsent", granted: false });
    expect((await h.get("/api/telemetry")).consent).toBe("declined");
    h.server.close();
  });
});

describe("sending", () => {
  const usedDays = async (h: Harness) => {
    await finishRun(h, "work");
    h.clock.now = atNoon("2026-10-11");
    await finishRun(h, "more work");
    h.clock.now = atNoon("2026-10-12");
  };

  it("sends nothing while consent is unset or declined", async () => {
    const h = await harness("unset");
    await usedDays(h);
    await h.server.telemetry.sendPendingDays();
    await h.command({ type: "setTelemetryConsent", granted: false });
    await h.server.telemetry.sendPendingDays();
    expect(h.posts).toEqual([]);
    h.server.close();
  });

  it("sends nothing while offline", async () => {
    process.env.BRANCHBOARD_OFFLINE = "1";
    try {
      const h = await harness("offline");
      await h.command({ type: "setTelemetryConsent", granted: true });
      await usedDays(h);
      await h.server.telemetry.sendPendingDays();
      expect(h.posts).toEqual([]);
      h.server.close();
    } finally {
      delete process.env.BRANCHBOARD_OFFLINE;
    }
  });

  it("sends each finished day after the consent day once and logs it", async () => {
    const h = await harness("granted");
    await h.command({ type: "setTelemetryConsent", granted: true });
    await usedDays(h);
    await h.server.telemetry.sendPendingDays();
    expect(h.posts.map((post) => post.payload.day)).toEqual(["2026-10-10", "2026-10-11"]);
    expect(h.posts[0].payload.runs.started).toBe(1);
    expect(new Set(h.posts.map((post) => post.payload.payloadId)).size).toBe(2);
    await h.server.telemetry.sendPendingDays();
    expect(h.posts).toHaveLength(2);
    const lines = readFileSync(h.server.telemetry.sentLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ status: 204, payload: h.posts[0].payload, sentAt: expect.any(String) });
    expect(telemetryFile(h).lastSentDay).toBe("2026-10-11");
    h.server.close();
  });

  it("contains no text from prompts, answers or paths", async () => {
    const h = await harness("private");
    await h.command({ type: "setTelemetryConsent", granted: true });
    await finishRun(h, "my secret plan for ACME corp");
    h.clock.now = atNoon("2026-10-11");
    await h.server.telemetry.sendPendingDays();
    const sent = JSON.stringify(h.posts);
    expect(sent).not.toMatch(/secret|ACME|Stats/);
    expect(sent).not.toContain(process.cwd());
    expect(sent).not.toContain(h.boardId);
    h.server.close();
  });

  it("retries a failed send on the next call with the same payload id", async () => {
    const h = await harness("retry");
    await h.command({ type: "setTelemetryConsent", granted: true });
    await finishRun(h, "work");
    h.clock.now = atNoon("2026-10-11");
    h.respondWith.status = 503;
    await h.server.telemetry.sendPendingDays();
    h.respondWith.status = "fail";
    await h.server.telemetry.sendPendingDays();
    expect(telemetryFile(h).lastSentDay).toBeUndefined();
    h.respondWith.status = 204;
    await h.server.telemetry.sendPendingDays();
    expect(h.posts.map((post) => post.payload.day)).toEqual(["2026-10-10", "2026-10-10", "2026-10-10"]);
    expect(new Set(h.posts.map((post) => post.payload.payloadId)).size).toBe(1);
    expect(telemetryFile(h).lastSentDay).toBe("2026-10-10");
    const statuses = readFileSync(h.server.telemetry.sentLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).status);
    expect(statuses).toEqual([503, null, 204]);
    h.server.close();
  });

  it("reads a consent file with unknown fields and a missing one", () => {
    const folder = join(directory, "reader");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "telemetry.json"), JSON.stringify({ schema: 1, consent: "granted", decidedAt: 5, decidedInVersion: "0.3.0", successfulRuns: 40, firstDay: "2026-10-01", future: { a: 1 } }));
    expect(createUsage({ dataDirectory: folder }).state()).toMatchObject({ consent: "granted", decidedAt: 5, successfulRuns: 40, firstDay: "2026-10-01" });
    writeFileSync(join(folder, "telemetry.json"), "{ broken");
    expect(createUsage({ dataDirectory: folder }).state()).toMatchObject({ successfulRuns: 0 });
    expect(createUsage({ dataDirectory: join(directory, "none-yet") }).state().consent).toBeUndefined();
  });
});
