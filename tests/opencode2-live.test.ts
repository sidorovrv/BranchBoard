import { createServer as createHttpServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createOpencode2Runtime, isShellInput, type Opencode2Config } from "../packages/server/src/runtimes/opencode2";
import { createServerPool, type OpencodeServer, type ServerAddress, type ServerPool } from "../packages/server/src/runtimes/opencodeServer";
import type { RunScope } from "../packages/server/src/run/types";

interface Recorded {
  method: string;
  path: string;
  body?: any;
}

type Reply = unknown | Response;

const eventStream = (events: object[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

const scriptedPool = (respond: (request: Recorded) => Reply) => {
  const requests: Recorded[] = [];
  const server = { baseUrl: "http://scripted", authorization: "", startedAt: 0 } as OpencodeServer;
  const call = async (_server: OpencodeServer, _directory: string, path: string, init: RequestInit = {}) => {
    const recorded: Recorded = { method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(recorded);
    const reply = respond(recorded);
    if (reply instanceof Response && !reply.ok) throw new Error(`${path} failed with ${reply.status}: ${await reply.text()}`);
    return reply instanceof Response ? reply : new Response(JSON.stringify(reply ?? {}), { headers: { "content-type": "application/json" } });
  };
  const pool = {
    servers: new Map(),
    secrets: () => [],
    call,
    callJson: async (...args: Parameters<typeof call>) => (await call(...args)).json(),
    post: (target: OpencodeServer, directory: string, path: string, body?: unknown) => call(target, directory, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
    serverFor: async () => server,
    stopAll: async () => undefined,
    onStop: () => undefined,
  } as unknown as ServerPool;
  server.pool = pool;
  return { pool, server, requests };
};

const handleOf = (server: OpencodeServer) => ({ server, directory: "/work", sessionId: "ses_1" });

const scopeOf = (): RunScope => ({ boardId: "b", nodeId: "n", workspacePath: "/work", files: [], signal: new AbortController().signal, setRuntimeRef: () => undefined, waitForAnswer: async () => "" }) as RunScope;

const runtimeOf = (pool: ServerPool, extra: Partial<Opencode2Config> = {}) => createOpencode2Runtime({ id: "opencode2", pool, ...extra });

const collect = async (events: AsyncIterable<{ type: string }>) => {
  const all: { type: string; [key: string]: unknown }[] = [];
  for await (const event of events) all.push(event);
  return all;
};

describe("OpenCode 2 runtime panels", () => {
  const servers = [{ name: "docs", status: { status: "connected" } }, { name: "search", status: { status: "pending" } }];

  const respond = (request: Recorded): Reply => {
    if (request.path === "/api/mcp") return { data: servers };
    if (request.path === "/api/permission/saved") return { data: [{ id: "p1", action: "edit", resource: "src/**", effect: "allow" }] };
    if (request.path === "/api/credential") return { data: [{ id: "c1", integrationID: "openai", label: "work", active: true, value: { type: "key", key: "sk-secret-value" } }] };
    if (request.path === "/api/shell") return { data: [{ id: "sh_old", status: "exited", exit: 1, command: "make" }, { id: "sh_new", status: "running", command: "npm run dev" }] };
    if (request.path.startsWith("/api/shell/sh_new/output")) return { data: { output: "ready on 3000\n" } };
    if (request.path.startsWith("/api/shell/")) return { data: { output: "" } };
    if (request.path === "/api/plugin") return { data: [{ id: "builtin.one", source: { type: "builtin" }, state: { status: "active" } }, { id: "pkg.two", source: { type: "package", target: "pkg-two@1" }, state: { status: "active" } }] };
    if (request.path === "/api/experimental/session/stats") return { data: { sessions: 2, subagents: 1, prompts: 3, steps: 4, tokens: { input: 10, output: 5, reasoning: 0 }, cost: 0.5, models: [{ model: { id: "m", providerID: "p" }, steps: 4, cost: 0.5 }] } };
    return { data: [] };
  };

  it("lists the details of a user install and offers actions per row", async () => {
    const { pool, requests } = scriptedPool(respond);
    const panels = await runtimeOf(pool).panels!("/work");
    expect(panels.map((panel) => panel.id)).toEqual(["permissions", "signIn", "mcp", "plugins", "shells", "references", "webSearch", "stats"]);
    const byId = Object.fromEntries(panels.map((panel) => [panel.id, panel]));
    expect(byId.mcp.rows).toEqual([
      { id: "docs", label: "docs", detail: "connected", actions: [{ id: "disconnect", label: "Disconnect" }] },
      { id: "search", label: "search", detail: "pending", actions: [{ id: "connect", label: "Connect" }] },
    ]);
    expect(byId.plugins.rows.map((row) => row.actions?.length ?? 0)).toEqual([0, 1]);
    expect(byId.shells.rows).toEqual([
      { id: "sh_new", label: "npm run dev", detail: "running\nready on 3000", actions: [{ id: "stop", label: "Stop" }] },
      { id: "sh_old", label: "make", detail: "exited with 1", actions: undefined },
    ]);
    expect(byId.stats.rows.map((row) => row.id)).toContain("p/m");
    expect(JSON.stringify(panels)).not.toContain("sk-secret-value");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("leaves out sign-in rows for the engine, which takes its keys from Branchboard", async () => {
    const { pool } = scriptedPool(respond);
    const panels = await runtimeOf(pool, { id: "openai", providerIds: ["openai"] }).panels!("/work");
    expect(panels.map((panel) => panel.id)).not.toContain("signIn");
  });

  it("turns a row action into the matching engine request", async () => {
    const { pool, requests } = scriptedPool(respond);
    const runtime = runtimeOf(pool);
    await runtime.panelAction!("mcp", "docs", "disconnect", "/work");
    await runtime.panelAction!("permissions", "p1", "remove", "/work");
    await runtime.panelAction!("signIn", "c1", "remove", "/work");
    await runtime.panelAction!("plugins", "pkg.two", "update", "/work");
    await runtime.panelAction!("shells", "sh_new", "stop", "/work");
    const writes = requests.filter((request) => request.method !== "GET");
    expect(writes).toEqual([
      { method: "POST", path: "/api/experimental/mcp/docs/disconnect", body: undefined },
      { method: "DELETE", path: "/api/permission/saved/p1", body: undefined },
      { method: "DELETE", path: "/api/credential/c1", body: undefined },
      { method: "POST", path: "/api/plugin/update", body: { targets: ["pkg-two@1"] } },
      { method: "DELETE", path: "/api/shell/sh_new", body: undefined },
    ]);
  });

  it("refuses an action the row does not offer", async () => {
    const { pool } = scriptedPool(respond);
    await expect(runtimeOf(pool).panelAction!("plugins", "builtin.one", "update", "/work")).rejects.toThrow("Unknown action");
    await expect(runtimeOf(pool).panelAction!("mcp", "missing", "connect", "/work")).rejects.toThrow("Unknown action");
  });
});

describe("OpenCode 2 live controls", () => {
  it("sends a follow-up as a steering prompt and moves a tool to the background", async () => {
    const { pool, server, requests } = scriptedPool(() => ({}));
    const runtime = runtimeOf(pool);
    await runtime.control!(handleOf(server), { type: "followUp", text: "also add tests" });
    await runtime.control!(handleOf(server), { type: "background" });
    expect(requests).toEqual([
      { method: "POST", path: "/api/session/ses_1/prompt", body: { text: "also add tests", delivery: "steer" } },
      { method: "POST", path: "/api/session/ses_1/background", body: undefined },
    ]);
  });

  it("recognises a shell prompt only when a command follows the prefix", () => {
    expect(isShellInput("!ls -la")).toBe(true);
    expect(isShellInput("!   ")).toBe(false);
    expect(isShellInput("run !ls")).toBe(false);
  });

  it("runs a shell prompt through the shell route and shows the output as a tool", async () => {
    const shell = { id: "sh_1", command: "echo hi", status: "running" };
    const { pool, server, requests } = scriptedPool((request) => {
      if (request.path === "/api/event") return eventStream([{ type: "session.shell.started", data: { sessionID: "ses_1", shell } }, { type: "session.shell.ended", data: { sessionID: "ses_1", shell: { ...shell, exit: 0 }, output: { output: "hi\n" } } }]);
      return {};
    });
    const events = await collect(runtimeOf(pool).execute(handleOf(server), "!echo hi", scopeOf()));
    expect(requests.find((request) => request.path === "/api/session/ses_1/shell")?.body).toEqual({ command: "echo hi" });
    expect(requests.some((request) => request.path === "/api/session/ses_1/prompt")).toBe(false);
    expect(events).toEqual([
      { type: "tool-start", partId: "sh_1", tool: "shell", description: "echo hi", input: { command: "echo hi" } },
      { type: "tool-done", partId: "sh_1", output: "hi\n", isError: false },
      { type: "idle" },
    ]);
  });

  it("sends the board's environment variables before the prompt, and clears them on a fork", async () => {
    const finished = [{ type: "session.execution.succeeded", data: { sessionID: "ses_1" } }];
    const withEnvironment = scriptedPool((request) => (request.path === "/api/event" ? eventStream(finished) : {}));
    await collect(runtimeOf(withEnvironment.pool).execute(handleOf(withEnvironment.server), "go", { ...scopeOf(), environment: { MODE: "dev" } }));
    const environment = withEnvironment.requests.find((request) => request.path === "/api/session/ses_1/environment");
    expect(environment).toEqual({ method: "PUT", path: "/api/session/ses_1/environment", body: { variables: { MODE: "dev" } } });
    expect(withEnvironment.requests.indexOf(environment!)).toBeLessThan(withEnvironment.requests.findIndex((request) => request.path === "/api/session/ses_1/prompt"));

    const forked = scriptedPool((request) => (request.path === "/api/event" ? eventStream(finished) : {}));
    await collect(runtimeOf(forked.pool).execute({ ...handleOf(forked.server), isFork: true }, "go", scopeOf()));
    expect(forked.requests.find((request) => request.path.endsWith("/environment"))?.body).toEqual({ variables: {} });

    const fresh = scriptedPool((request) => (request.path === "/api/event" ? eventStream(finished) : {}));
    await collect(runtimeOf(fresh.pool).execute(handleOf(fresh.server), "go", scopeOf()));
    expect(fresh.requests.some((request) => request.path.endsWith("/environment"))).toBe(false);
  });

  it("ignores shell events of a normal prompt", async () => {
    const shell = { id: "sh_1", command: "ls", status: "running" };
    const { pool, server } = scriptedPool((request) => {
      if (request.path === "/api/event") return eventStream([{ type: "session.shell.started", data: { sessionID: "ses_1", shell } }, { type: "session.execution.succeeded", data: { sessionID: "ses_1" } }]);
      return {};
    });
    const events = await collect(runtimeOf(pool).execute(handleOf(server), "list files", scopeOf()));
    expect(events).toEqual([{ type: "idle" }]);
  });
});

describe("OpenCode 2 stream resume", () => {
  const partial = { type: "session.text.delta", data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: "Hel" } };

  it("reads the finished answer when the stream breaks after the session ended", async () => {
    const { pool, server } = scriptedPool((request) => {
      if (request.path === "/api/event") return eventStream([partial]);
      if (request.path === "/api/session/active") return { data: {} };
      if (request.path === "/api/session/ses_1/context") return { data: [{ id: "msg_u", type: "user", text: "hi" }, { id: "msg_a", type: "assistant", content: [{ type: "text", text: "Hello there" }] }, { id: "msg_i", type: "idle", outcome: "succeeded" }] };
      return {};
    });
    const events = await collect(runtimeOf(pool).execute(handleOf(server), "hi", scopeOf()));
    expect(events).toEqual([
      { type: "text", partId: "msg_a:text:0", delta: "Hel" },
      { type: "text", partId: "msg_a:text:0", delta: "lo there" },
      { type: "idle" },
    ]);
  });

  it("numbers parts per kind and reads every message of the run", async () => {
    const entries = [
      { id: "msg_old", type: "assistant", content: [{ type: "text", text: "Earlier run" }] },
      { id: "msg_u", type: "user", text: "hi" },
      { id: "msg_a", type: "assistant", content: [{ type: "reasoning", text: "Think" }, { type: "text", text: "Before" }, { type: "tool", id: "call_1" }] },
      { id: "msg_b", type: "assistant", content: [{ type: "text", text: "After" }] },
      { id: "msg_i", type: "idle", outcome: "succeeded" },
    ];
    const { pool, server } = scriptedPool((request) => {
      if (request.path === "/api/event") return eventStream([]);
      if (request.path === "/api/session/active") return { data: {} };
      if (request.path === "/api/session/ses_1/context") return { data: entries };
      return {};
    });
    const events = await collect(runtimeOf(pool).execute(handleOf(server), "hi", scopeOf()));
    expect(events).toEqual([
      { type: "reasoning", partId: "msg_a:reasoning:0", delta: "Think" },
      { type: "text", partId: "msg_a:text:0", delta: "Before" },
      { type: "text", partId: "msg_b:text:0", delta: "After" },
      { type: "idle" },
    ]);
  });

  it("reports a failure when the session ended without succeeding", async () => {
    const { pool, server } = scriptedPool((request) => {
      if (request.path === "/api/event") return eventStream([]);
      if (request.path === "/api/session/active") return { data: {} };
      if (request.path === "/api/session/ses_1/context") return { data: [{ id: "msg_i", type: "idle", outcome: "failed" }] };
      return {};
    });
    const events = await collect(runtimeOf(pool).execute(handleOf(server), "hi", scopeOf()));
    expect(events.map((event) => event.type)).toEqual(["failure"]);
  });

  it("opens a new event stream when the session is still running", async () => {
    let streams = 0;
    const { pool, server } = scriptedPool((request) => {
      if (request.path === "/api/event") return eventStream(++streams === 1 ? [partial] : [{ type: "session.text.ended", data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, text: "Hello" } }, { type: "session.execution.succeeded", data: { sessionID: "ses_1" } }]);
      if (request.path === "/api/session/active") return { data: { ses_1: { type: "running" } } };
      return {};
    });
    const events = await collect(runtimeOf(pool).execute(handleOf(server), "hi", scopeOf()));
    expect(streams).toBe(2);
    expect(events.map((event) => event.delta ?? event.type)).toEqual(["Hel", "lo", "idle"]);
  });

  it("fails after the resume attempts are used up", async () => {
    const { pool, server } = scriptedPool((request) => (request.path === "/api/event" ? eventStream([]) : request.path === "/api/session/active" ? { data: { ses_1: { type: "running" } } } : {}));
    const events = await collect(runtimeOf(pool).execute(handleOf(server), "hi", scopeOf()));
    expect(events.map((event) => event.type)).toEqual(["failure"]);
  });
});

describe("OpenCode 2 files", () => {
  it("tells the user which attached files the model cannot take before sending the prompt", async () => {
    const models = { data: [{ providerID: "openai", modelID: "gpt", enabled: true, capabilities: { tools: true, input: ["text"], output: ["text"] } }] };
    const { pool, server, requests } = scriptedPool((request) => {
      if (request.path === "/api/event") return eventStream([{ type: "session.execution.succeeded", data: { sessionID: "ses_1" } }]);
      if (request.path === "/api/model") return models;
      return {};
    });
    const scope = { ...scopeOf(), model: "openai/gpt", files: [{ name: "shot.png", mime: "image/png", path: "/work/shot.png" }] } as RunScope;
    const events = await collect(runtimeOf(pool).execute({ ...handleOf(server), model: { id: "gpt", providerID: "openai" } }, "look", scope));
    expect(events[0]).toEqual({ type: "text", partId: "files:unsent", delta: "shot.png was not sent: the model does not accept image files.\n\n" });
    const order = requests.map((request) => request.path);
    expect(order.indexOf("/api/model")).toBeLessThan(order.indexOf("/api/session/ses_1/prompt"));
    expect(requests.find((request) => request.path === "/api/session/ses_1/prompt")!.body.files).toHaveLength(1);
  });
});

describe("OpenCode 2 session calls", () => {
  it("tests a connection with one generate call on the first listed model", async () => {
    const { pool, requests } = scriptedPool((request) => (request.path === "/api/model" ? { data: [{ providerID: "openai", modelID: "gpt", enabled: true }] } : { data: { text: "ok" } }));
    expect(await runtimeOf(pool).testConnection!()).toEqual({ ok: true, detail: "Connected. 1 models available." });
    const generate = requests.find((request) => request.path === "/api/experimental/generate")!;
    expect(generate.body.model).toEqual({ id: "gpt", providerID: "openai" });
  });

  it("reports the message of a failed connection test", async () => {
    const { pool } = scriptedPool((request) => (request.path === "/api/model" ? { data: [{ providerID: "openai", modelID: "gpt", enabled: true }] } : new Response(JSON.stringify({ message: "Invalid key" }), { status: 503 })));
    const result = await runtimeOf(pool).testConnection!();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Invalid key");
  });

  it("deletes a session by id", async () => {
    const { pool, requests } = scriptedPool(() => ({}));
    await runtimeOf(pool).dropSession!({ sessionId: "ses_old" }, "/work");
    expect(requests).toEqual([{ method: "DELETE", path: "/api/session/ses_old", body: undefined }]);
  });

  it("fails the run when the stream ends and the session is gone from the active list without an outcome", async () => {
    const { pool, server } = scriptedPool((request) => {
      if (request.path === "/api/event") return eventStream([]);
      if (request.path === "/api/session/active") return { data: {} };
      if (request.path === "/api/session/ses_1/context") return { data: [{ id: "msg_u", type: "user", text: "hi" }] };
      return {};
    });
    const events = await collect(runtimeOf(pool).execute(handleOf(server), "hi", scopeOf()));
    expect(events).toEqual([{ type: "failure", message: expect.stringContaining("The connection closed before the answer finished"), recovery: undefined }]);
  });
});

describe("OpenCode 2 server address", () => {
  const serving = async (password: string | undefined) => {
    const requests: { path: string; authorization?: string }[] = [];
    const server = createHttpServer((request, response) => {
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
      const expected = password ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : undefined;
      const isAllowed = expected === undefined || request.headers.authorization === expected;
      response.writeHead(isAllowed ? 200 : 401, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { server, requests, baseUrl: `http://127.0.0.1:${port}` };
  };

  const poolFor = (address: ServerAddress | undefined) => createServerPool({ logName: "test", label: "OpenCode 2", healthPath: "/api/info", isShared: true, remote: () => address, missingMessage: "missing" });

  it("connects to the configured address with the password and starts no process", async () => {
    const { server, requests, baseUrl } = await serving("secret");
    const pool = poolFor({ baseUrl, password: "secret" });
    const connected = await pool.serverFor("/work");
    expect(connected.child).toBeUndefined();
    expect(connected.baseUrl).toBe(baseUrl);
    expect(requests).toEqual([{ path: "/api/info", authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}` }]);
    expect(await pool.serverFor("/other")).toBe(connected);
    expect([...pool.servers.keys()].join()).not.toContain("secret");
    server.close();
  });

  it("asks for setup when the password is refused or nothing answers", async () => {
    const { server, baseUrl } = await serving("secret");
    await expect(poolFor({ baseUrl, password: "wrong" }).serverFor("/work")).rejects.toThrow(/refused the password/);
    server.close();
    await expect(poolFor({ baseUrl }).serverFor("/work")).rejects.toThrow(/did not answer/);
  });
});
