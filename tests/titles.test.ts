import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BoardView, GraphNode } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { cleanTitle, suggestTitle, titleInstruction } from "../packages/server/src/run/titles";
import { pickSmallModel } from "../packages/server/src/runtimes/smallModel";
import { fakeRuntime } from "../packages/server/src/runtimes/fake";
import type { RuntimeSteps } from "../packages/server/src/run/types";

const PORT = 47124;
const trusted = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
const directory = mkdtempSync(join(tmpdir(), "branchboard-titles-"));

const TITLE_REPLY = '"Banana Facts."';

const titlingRuntime: RuntimeSteps = {
  ...fakeRuntime,
  canSuggestTitles: true,
  openSession: async (plan, scope) => ({ ...(await fakeRuntime.openSession(plan, scope)), sessionId: `titled-${Math.random()}` }),
  execute: async function* (handle, input, scope) {
    if (!input.startsWith("Write a title")) return yield* fakeRuntime.execute(handle, input, scope);
    yield { type: "chunk", text: TITLE_REPLY };
  },
};

let server: ReturnType<typeof createApp>;
let boardId = "";

const command = async (body: Record<string, unknown>) => {
  const response = await server.app.request(`http://127.0.0.1:${PORT}/api/commands`, { method: "POST", headers: trusted, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
};

const nodeOf = async (nodeId: string): Promise<GraphNode> => {
  const response = await server.app.request(`http://127.0.0.1:${PORT}/api/boards/${boardId}/graph`, { headers: trusted });
  return ((await response.json()) as BoardView).graph.nodes[nodeId];
};

const boardTitleOf = async (id: string): Promise<string> => {
  const response = await server.app.request(`http://127.0.0.1:${PORT}/api/boards/${id}/graph`, { headers: trusted });
  return ((await response.json()) as { board: { title: string } }).board.title;
};

const waitFor = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
};

beforeAll(async () => {
  server = createApp({
    databasePath: join(directory, "titles.db"),
    security: { port: PORT, extraOrigins: [] },
    webRoot: join(directory, "none"),
    runtimes: { fake: titlingRuntime, opencode: titlingRuntime, claude: titlingRuntime },
  });
  boardId = (await command({ type: "createBoard", title: "Titles", workspacePath: process.cwd(), mode: "fake" })).json.id;
});

afterAll(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("title model", () => {
  const seenModels: (string | undefined)[] = [];
  const recording = (titleModel?: RuntimeSteps["titleModel"]): RuntimeSteps => ({
    ...titlingRuntime,
    titleModel,
    execute: async function* (handle, input, scope) {
      seenModels.push(scope.model);
      yield* titlingRuntime.execute(handle, input, scope);
    },
  });
  const request = { scope: { boardId: "b", nodeId: "n", workspacePath: process.cwd(), model: "big/model" }, prompt: "p" };

  it("uses the runtime's cheaper model for the title when it names one", async () => {
    seenModels.length = 0;
    await suggestTitle({ ...request, runtime: recording(async () => "small/model") });
    expect(seenModels).toEqual(["small/model"]);
  });

  it("falls back to the node's own model when none is named or the lookup fails", async () => {
    seenModels.length = 0;
    await suggestTitle({ ...request, runtime: recording(async () => undefined) });
    await suggestTitle({ ...request, runtime: recording(async () => Promise.reject(new Error("no config"))) });
    expect(seenModels).toEqual(["big/model", "big/model"]);
  });
});

describe("picking a small model without configuration", () => {
  const providers: Parameters<typeof pickSmallModel>[0] = [
    {
      id: "acme",
      models: {
        big: { id: "big", cost: { input: 15, output: 75 }, limit: { context: 200000 } },
        mid: { id: "mid", cost: { input: 3, output: 15 } },
        tiny: { id: "tiny-flash", cost: { input: 0.1, output: 0.4 } },
        cheaper: { id: "tiny-old", cost: { input: 0.1, output: 0.4 }, status: "deprecated" },
        embed: { id: "text-embedding", cost: { input: 0, output: 0 } },
      },
    },
    { id: "freebies", models: { a: { id: "alpha", cost: { input: 0, output: 0 } }, b: { id: "beta-mini", cost: { input: 0, output: 0 } } } },
    { id: "unpriced", models: { x: { id: "x-large" }, y: { id: "y-lite" } } },
  ];

  it("takes the cheapest usable model of the node's own provider", () => {
    expect(pickSmallModel(providers, "acme/big")).toBe("acme/tiny-flash");
  });

  it("prefers a small-sounding name among equally priced free models", () => {
    expect(pickSmallModel(providers, "freebies/alpha")).toBe("freebies/beta-mini");
  });

  it("uses names alone when no prices are known, and gives up when nothing qualifies", () => {
    expect(pickSmallModel(providers, "unpriced/x-large")).toBe("unpriced/y-lite");
    expect(pickSmallModel(providers, "elsewhere/model")).toBeUndefined();
    expect(pickSmallModel(providers, undefined)).toBeUndefined();
  });
});

describe("cleanTitle", () => {
  it.each([
    ['"Banana Facts."', "Banana Facts"],
    ["Title: Apple pie recipe\nbecause it is about pies", "Apple pie recipe"],
    ["# **Quick Summary**", "Quick Summary"],
    ["   \n  ", undefined],
  ])("cleans %j", (raw, expected) => {
    expect(cleanTitle(raw)).toBe(expected);
  });

  it("truncates long titles", () => {
    expect(cleanTitle("word ".repeat(40))!.length).toBeLessThanOrEqual(33);
  });

  it("asks for a short title without tools", () => {
    expect(titleInstruction("question")).toContain("Do not use any tools");
  });

  it("is built from the prompt alone", () => {
    expect(titleInstruction("question")).not.toContain("Assistant:");
  });
});

describe("automatic node titles", () => {
  it("replaces the prompt-derived title with a generated one after the first run", async () => {
    const nodeId = (await command({ type: "reply", boardId, prompt: "what is a banana, really?" })).json.nodeId;
    await waitFor(async () => (await nodeOf(nodeId)).title === "Banana Facts");
  });

  it("names only new nodes and branches, not plain replies", async () => {
    const root = (await command({ type: "reply", boardId, prompt: "root question" })).json.nodeId;
    await waitFor(async () => (await nodeOf(root)).title === "Banana Facts");
    const reply = (await command({ type: "reply", boardId, parentIds: [root], prompt: "plain follow up" })).json.nodeId;
    await waitFor(async () => (await nodeOf(reply)).status === "done");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await nodeOf(reply)).title).toBe("Banana Facts");
    const branch = (await command({ type: "reply", boardId, parentIds: [root], prompt: "forked question" })).json.nodeId;
    await waitFor(async () => (await nodeOf(branch)).title === "Banana Facts › Banana Facts");
  });

  it("names an untitled board after its first prompt", async () => {
    const untitled = (await command({ type: "createBoard", workspacePath: process.cwd(), mode: "fake" })).json.id;
    expect(await boardTitleOf(untitled)).toBe("Untitled board");
    await command({ type: "reply", boardId: untitled, prompt: "first prompt" });
    await waitFor(async () => (await boardTitleOf(untitled)) === "Banana Facts");
  });

  it("leaves a title the user chose alone", async () => {
    const nodeId = (await command({ type: "reply", boardId, prompt: "" })).json.nodeId;
    await command({ type: "editNode", boardId, nodeId, fields: { title: "My own name" } });
    await command({ type: "run", boardId, nodeId, prompt: "something else" });
    await waitFor(async () => (await nodeOf(nodeId)).status === "done");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await nodeOf(nodeId)).title).toBe("My own name");
  });
});
