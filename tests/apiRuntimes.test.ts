import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../packages/server/src/app";
import { createCredentialStore } from "../packages/server/src/credentials";
import { configureLogFile } from "../packages/server/src/log";
import { createApiRuntime } from "../packages/server/src/runtimes/apiRuntime";
import { anthropicProvider } from "../packages/server/src/runtimes/anthropicApi";
import { openaiProvider } from "../packages/server/src/runtimes/openaiApi";
import { fakeRuntime } from "../packages/server/src/runtimes/fake";
import { opencodeRuntime } from "../packages/server/src/runtimes/opencodeAuto";
import { sseData } from "../packages/server/src/runtimes/sse";
import { createClaudeRuntime } from "../packages/server/src/runtimes/claude";
import { isLocalBaseUrl, needsKey, type GraphNode } from "@branchboard/core";

const PORT = 47341;
const HOST = `127.0.0.1:${PORT}`;
const trusted = { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" };
const KEY = ["sk-ant-", "api03-TESTKEYTESTKEYTESTKEY1234"].join("");
const OPENAI_KEY = "sk-openai-TESTKEYTESTKEYTESTKEY5678";
const directory = mkdtempSync(join(tmpdir(), "branchboard-api-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const sse = (events: (object | string)[]): Response =>
  new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

interface Seen {
  url: string;
  headers: Record<string, string>;
  body?: any;
  redirect?: string;
}

const scriptedFetch = (respond: (seen: Seen) => Response | Promise<Response>) => {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const record: Seen = { url: String(url), headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value])), body: init.body ? JSON.parse(String(init.body)) : undefined, redirect: init.redirect };
    seen.push(record);
    return respond(record);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
};

const anthropicAnswer = (text: string[], usage = { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }): Response =>
  sse([
    { type: "message_start", message: { usage: { ...usage, output_tokens: 1 } } },
    { type: "ping" },
    ...text.map((piece) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } })),
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]);

describe("credential store", () => {
  const folder = mkdtempSync(join(directory, "cred-"));

  it("saves a key without ever reporting it back, and removes it", () => {
    const store = createCredentialStore(folder);
    expect(store.status("anthropic")).toMatchObject({ saved: false, baseUrl: "https://api.anthropic.com" });
    const status = store.set("anthropic", KEY, undefined);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(status.saved).toBe(true);
    expect(store.credentialOf("anthropic").key).toBe(KEY);
    expect(JSON.stringify(store.status("anthropic"))).not.toContain(KEY);
    if (process.platform !== "win32") expect(statSync(join(folder, "credentials.json")).mode & 0o777).toBe(0o600);
    store.set("anthropic", null, undefined);
    expect(store.status("anthropic").saved).toBe(false);
  });

  it("deletes the key when the base URL changes without a new key", () => {
    const store = createCredentialStore(mkdtempSync(join(directory, "cred-")));
    store.set("openai", OPENAI_KEY, "https://api.example.com/v1");
    expect(store.set("openai", undefined, "https://api.example.com/v1/").saved).toBe(true);
    expect(store.set("openai", undefined, "https://evil.example.com/v1").saved).toBe(false);
    expect(store.credentialOf("openai")).toEqual({ key: undefined, baseUrl: "https://evil.example.com/v1" });
    expect(store.set("openai", OPENAI_KEY, "https://other.example.com/v1").saved).toBe(true);
  });

  it("fixes the Anthropic address and checks custom ones", () => {
    const store = createCredentialStore(mkdtempSync(join(directory, "cred-")));
    expect(store.set("anthropic", KEY, "https://evil.example.com").baseUrl).toBe("https://api.anthropic.com");
    expect(() => store.set("openai", KEY, "http://example.com/v1")).toThrow(/https/);
    expect(() => store.set("openai", KEY, "https://user:pass@example.com/v1")).toThrow();
    expect(() => store.set("openai", KEY, "not a url")).toThrow();
    expect(store.set("openai", undefined, "http://localhost:11434/v1").baseUrl).toBe("http://localhost:11434/v1");
    expect(() => store.set("claude" as never, KEY, undefined)).toThrow();
    expect(() => store.set("anthropic", "has space", undefined)).toThrow();
  });

  it("does not need a key for a local server only when the runtime allows it", () => {
    expect(isLocalBaseUrl("http://localhost:1234/v1")).toBe(true);
    expect(needsKey("openai", "http://127.0.0.1:1234/v1")).toBe(false);
    expect(needsKey("openai", "https://api.openai.com/v1")).toBe(true);
    expect(needsKey("anthropic", "http://localhost:1234")).toBe(true);
  });
});

describe("server-sent events", () => {
  const streamOf = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(controller) { chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk))); controller.close(); } });
  const collect = async (chunks: string[]) => {
    const found: string[] = [];
    for await (const data of sseData(streamOf(chunks))) found.push(data);
    return found;
  };

  it("joins multi-line data, ignores comments and event names, and copes with split chunks and CRLF", async () => {
    expect(await collect([": hello\n\nevent: x\ndata: one\n\n", "data: tw", "o\r\ndata: lines\r\n\r\n", "data: [DONE]\n\n"])).toEqual(["one", "two\nlines", "[DONE]"]);
  });

  it("yields a final event that has no closing blank line", async () => {
    expect(await collect(["data: last"])).toEqual(["last"]);
  });
});

describe("API runtimes through the board", () => {
  let server: ReturnType<typeof createApp>;
  let credentials: ReturnType<typeof createCredentialStore>;
  let fetches: ReturnType<typeof scriptedFetch>;
  let behaviour: (seen: Seen) => Response | Promise<Response>;
  let boardId = "";
  const workspace = join(directory, "workspace");

  const send = async (path: string, body?: unknown) => {
    const response = await server.app.request(`http://${HOST}${path}`, { method: body ? "POST" : "GET", headers: trusted, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, text, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined };
  };
  const command = (body: Record<string, unknown>) => send("/api/commands", body);
  const graphOf = async () => (await send(`/api/boards/${boardId}/graph`)).json as { graph: { nodes: Record<string, GraphNode> }; parts: Record<string, { type: string; text: string; meta?: Record<string, unknown> }[]> };
  const run = async (prompt: string, parentIds: string[] = []) => {
    const nodeId = (await command({ type: "reply", boardId, prompt, parentIds })).json.nodeId;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (["done", "error"].includes((await graphOf()).graph.nodes[nodeId].status)) return nodeId;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The run did not finish");
  };

  beforeAll(async () => {
    mkdirSync(workspace);
    mkdirSync(join(directory, "logs"));
    configureLogFile(join(directory, "logs", "server.log"));
    process.env.BRANCHBOARD_LOG_LEVEL = "debug";
    const dataFolder = mkdtempSync(join(directory, "data-"));
    credentials = createCredentialStore(dataFolder);
    fetches = scriptedFetch((seen) => behaviour(seen));
    behaviour = (seen) => (seen.url.includes("/v1/models") ? Response.json({ data: [{ id: "claude-test-1", display_name: "Test 1", max_input_tokens: 200000 }] }) : anthropicAnswer(["Hel", "lo"]));
    const anthropic = createApiRuntime(anthropicProvider, { credentials, fetchImpl: fetches.fetchImpl });
    const openai = createApiRuntime(openaiProvider, { credentials, fetchImpl: fetches.fetchImpl });
    server = createApp({
      databasePath: join(dataFolder, "t.db"),
      security: { port: PORT, extraOrigins: [] },
      runtimes: { fake: fakeRuntime, opencode: opencodeRuntime, claude: createClaudeRuntime({ serverUrl: "http://x" }), anthropic, openai },
    });
    expect((await command({ type: "setCredential", runtimeId: "anthropic", key: KEY })).status).toBe(200);
    boardId = (await command({ type: "createBoard", title: "API", workspacePath: workspace, mode: "anthropic" })).json.id;
  });

  afterAll(() => {
    server.close();
    configureLogFile(undefined);
  });

  it("streams an answer, records usage and sends the key only to the bound address", async () => {
    const nodeId = await run("say hello");
    const { graph, parts } = await graphOf();
    expect(parts[nodeId].filter((part) => part.type === "text").map((part) => part.text).join("")).toBe("Hello");
    expect(graph.nodes[nodeId]).toMatchObject({ status: "done", usage: { inputTokens: 15, outputTokens: 7, contextTokens: 15, cacheReadTokens: 5 } });
    expect(graph.nodes[nodeId].runtimeRef).toBeUndefined();
    const chat = fetches.seen.filter((entry) => entry.url.endsWith("/v1/messages")).at(-1)!;
    expect(chat.url).toBe("https://api.anthropic.com/v1/messages");
    expect(chat.headers["x-api-key"]).toBe(KEY);
    expect(chat.redirect).toBe("error");
    expect(chat.body).toMatchObject({ model: "claude-test-1", stream: true, max_tokens: 8192 });
    expect(chat.body.messages[0].content.at(-1).text).toContain("say hello");
    expect(fetches.seen.every((entry) => entry.url.startsWith("https://api.anthropic.com/"))).toBe(true);
  });

  it("always sends the whole context as text because there is no session to fork", async () => {
    const first = await run("remember seven");
    const second = await run("what did I say", [first]);
    expect((await graphOf()).graph.nodes[second].contextMode).toBe("assembled");
    const chat = fetches.seen.filter((entry) => entry.url.endsWith("/v1/messages")).at(-1)!;
    expect(JSON.stringify(chat.body)).toContain("remember seven");
  });

  it("offers a setup action when the key is rejected, without echoing the key", async () => {
    behaviour = (seen) => (seen.url.includes("/v1/models") ? Response.json({ data: [] }) : Response.json({ error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }, { status: 401 }));
    const nodeId = await run("will fail");
    const { graph, parts } = await graphOf();
    const error = parts[nodeId].find((part) => part.type === "error")!;
    expect(graph.nodes[nodeId].status).toBe("error");
    expect(error.meta?.recovery).toBe("setup");
    expect(error.text).toMatch(/rejected the API key/);
    expect(error.text).not.toContain(KEY);
  });

  it("marks a rate limit as a usage limit", async () => {
    behaviour = () => Response.json({ error: { type: "rate_limit_error", message: "slow down" } }, { status: 429 });
    const nodeId = await run("too many");
    expect((await graphOf()).parts[nodeId].find((part) => part.type === "error")?.meta?.recovery).toBe("usageLimit");
  });

  it("refuses a redirect instead of following it", async () => {
    behaviour = () => {
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    };
    const nodeId = await run("redirect me");
    expect((await graphOf()).parts[nodeId].find((part) => part.type === "error")?.text).toMatch(/redirect/);
  });

  it("reports a stream that stops early", async () => {
    behaviour = () => sse([{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "content_block_delta", delta: { type: "text_delta", text: "part" } }]);
    const nodeId = await run("cut short");
    const { graph, parts } = await graphOf();
    expect(graph.nodes[nodeId].status).toBe("error");
    expect(parts[nodeId].find((part) => part.type === "error")?.text).toMatch(/closed before/);
  });

  it("turns a provider error event into an error", async () => {
    behaviour = () => sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]);
    const nodeId = await run("busy");
    expect((await graphOf()).parts[nodeId].find((part) => part.type === "error")?.text).toBe("Overloaded");
  });

  it("tests the key with one model-list call", async () => {
    behaviour = () => Response.json({ data: [{ id: "a" }, { id: "b" }] });
    expect((await command({ type: "testCredential", runtimeId: "anthropic" })).json).toEqual({ ok: true, detail: "Connected. 2 models available." });
    behaviour = () => Response.json({ error: { message: `bad key ${KEY}` } }, { status: 401 });
    const failed = (await command({ type: "testCredential", runtimeId: "anthropic" })).json;
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(KEY);
    expect((await command({ type: "testCredential", runtimeId: "claude" })).status).toBe(409);
  });

  it("never lets the key out through catalog, health, report, logs, export or command replies", async () => {
    behaviour = (seen) => (seen.url.includes("/models") ? Response.json({ data: [{ id: "claude-test-1" }] }) : anthropicAnswer(["ok"]));
    await command({ type: "setCredential", runtimeId: "openai", key: OPENAI_KEY, baseUrl: "https://api.example.com/v1" });
    await run("a prompt");
    const replies = [
      await command({ type: "setCredential", runtimeId: "anthropic", key: KEY }),
      await send(`/api/runtime/catalog?board=${boardId}`),
      await send("/api/runtime/catalog?mode=anthropic"),
      await send("/api/health"),
      await send("/api/report"),
      await send("/api/logs"),
      await send(`/api/boards/${boardId}/export`),
      await send(`/api/boards/${boardId}/graph`),
    ];
    replies.forEach((reply) => {
      expect(reply.text).not.toContain(KEY);
      expect(reply.text).not.toContain(OPENAI_KEY);
    });
    expect(readFileSync(join(directory, "logs", "server.log"), "utf8")).not.toContain(KEY);
    expect((await send("/api/runtime/catalog?mode=anthropic")).json.credential).toMatchObject({ saved: true, baseUrl: "https://api.anthropic.com" });
  });

  it("is unavailable until a key is saved and offers setup then", async () => {
    await command({ type: "setCredential", runtimeId: "anthropic", key: null });
    const catalog = (await send("/api/runtime/catalog?mode=anthropic")).json;
    expect(catalog.health.ok).toBe(false);
    expect(catalog.credential.saved).toBe(false);
    const refused = await command({ type: "createBoard", title: "No key", workspacePath: workspace, mode: "anthropic", projectId: undefined });
    expect(refused.status).toBe(200);
    const node = await run("no key now");
    expect((await graphOf()).parts[node].find((part) => part.type === "error")?.meta?.recovery).toBe("setup");
  });
});

describe("OpenAI-compatible runtime", () => {
  it("streams chat completions and works without a key on a local server", async () => {
    const credentials = createCredentialStore(mkdtempSync(join(directory, "oa-")));
    credentials.set("openai", undefined, "http://localhost:11434/v1");
    const { fetchImpl, seen } = scriptedFetch(() =>
      sse([
        { choices: [{ delta: { role: "assistant", content: "Hi" } }] },
        { choices: [{ delta: { content: " there" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } },
        "[DONE]",
      ]),
    );
    const runtime = createApiRuntime(openaiProvider, { credentials, fetchImpl });
    const scope = { boardId: "b", nodeId: "n", workspacePath: directory, model: "llama3", systemNote: "be brief", files: [], signal: new AbortController().signal, setRuntimeRef: () => undefined, waitForAnswer: async () => "reject" };
    const handle = await runtime.openSession({ missingTurns: [] }, scope);
    const events = [];
    for await (const native of runtime.execute(handle, "hello", scope)) events.push(...(runtime.eventMap[native.type]?.(native, scope) ?? []));
    expect(events.filter((event) => event.type === "part.delta").map((event) => (event as { text: string }).text).join("")).toBe("Hi there");
    expect(events.find((event) => event.type === "usage")).toMatchObject({ usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 } });
    expect(seen[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].body.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(seen[0].body.stream_options).toEqual({ include_usage: true });
  });

  it("needs a key for a remote address", async () => {
    const credentials = createCredentialStore(mkdtempSync(join(directory, "oa-")));
    const runtime = createApiRuntime(openaiProvider, { credentials, fetchImpl: scriptedFetch(() => Response.json({})).fetchImpl });
    expect((await runtime.catalog(directory)).health.ok).toBe(false);
    credentials.set("openai", OPENAI_KEY, undefined);
    expect((await runtime.catalog(directory)).health.ok).toBe(true);
  });

  it("falls back to the built-in model list when the provider cannot list models", async () => {
    const credentials = createCredentialStore(mkdtempSync(join(directory, "oa-")));
    credentials.set("anthropic", KEY, undefined);
    const runtime = createApiRuntime(anthropicProvider, { credentials, fetchImpl: scriptedFetch(() => Response.json({}, { status: 500 })).fetchImpl });
    const catalog = await runtime.catalog(directory);
    expect(catalog.health.ok).toBe(true);
    expect(catalog.models.map((model) => model.id)).toContain("claude-sonnet-5-5");
  });
});

describe("where keys may be touched", () => {
  const sourcesUnder = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sourcesUnder(join(folder, entry.name)) : entry.name.endsWith(".ts") ? [join(folder, entry.name)] : []));
  const serverSources = sourcesUnder(join(__dirname, "..", "packages", "server", "src"));
  const named = (needle: string) => serverSources.filter((path) => readFileSync(path, "utf8").includes(needle)).map((path) => path.replace(/\\/g, "/").split("/").at(-1));

  it("keeps credentials.json inside credentials.ts", () => {
    expect(named("credentials.json")).toEqual(["credentials.ts"]);
  });

  it("lets only the API runtime and the store read a key", () => {
    expect(named("credentialOf(").sort()).toEqual(["apiRuntime.ts", "credentials.ts"]);
  });

  it("never reads keys from the environment and keeps CLI runtimes away from the store", () => {
    ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "process.env"].forEach((needle) => {
      const offenders = named(needle).filter((name) => ["apiRuntime.ts", "anthropicApi.ts", "openaiApi.ts", "credentials.ts"].includes(name!));
      expect(offenders, needle).toEqual([]);
    });
    const cliRuntimes = serverSources.filter((path) => /runtimes[\\/](claude|opencode)/.test(path));
    cliRuntimes.forEach((path) => expect(readFileSync(path, "utf8")).not.toMatch(/credentials|CredentialStore/i));
  });
});
