import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_VERSION } from "../packages/server/src/engine/locator";
import { createOpencode2Runtime } from "../packages/server/src/runtimes/opencode2";
import type { OpencodeServer, ServerPool } from "../packages/server/src/runtimes/opencodeServer";
import type { RunScope } from "../packages/server/src/run/types";

const ENGINE_BINARY = process.env.BRANCHBOARD_LIVE_ENGINE;
const PASSWORD = "live";

const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], usage: finish ? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } : undefined })}\n\n`;

const answerOf = (messages: { role: string }[]): string => {
  const afterTool = messages[messages.length - 1]?.role === "tool";
  if (afterTool) return chunk({ role: "assistant", content: "After the tool." }) + chunk({}, "stop");
  const call = { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } };
  return chunk({ role: "assistant", reasoning_content: "Thinking first." }) + chunk({ content: "Before the tool. " }) + chunk({ tool_calls: [call] }) + chunk({}, "tool_calls");
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createSocketServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const startMock = (port: number) =>
  new Promise<Server>((resolve) => {
    const server = createHttpServer((request, response) => {
      let raw = "";
      request.on("data", (part) => (raw += part));
      request.on("end", () => {
        if (request.url?.endsWith("/models")) return response.end(JSON.stringify({ data: [{ id: "mock-ok" }] }));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`${answerOf(JSON.parse(raw || "{}").messages ?? [])}data: [DONE]\n\n`);
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

const cutAfter = (response: Response, marker: string): Response => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      controller.enqueue(value);
      seen += decoder.decode(value, { stream: true });
      if (seen.includes(marker)) {
        await reader.cancel();
        controller.close();
      }
    },
  });
  return new Response(body, { headers: response.headers });
};

describe.skipIf(!ENGINE_BINARY)("live engine stream resume", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-live-"));
  const workspace = join(root, "work");
  let engine: ChildProcess;
  let mock: Server;
  let base = "";

  const authorization = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;

  beforeAll(async () => {
    mkdirSync(workspace, { recursive: true });
    const [enginePort, mockPort] = [await freePort(), await freePort()];
    mock = await startMock(mockPort);
    const providers = { mock: { name: "Mock", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "k" }, models: { "mock-ok": { name: "Mock OK" } } } };
    const home = join(root, "home");
    engine = spawn(ENGINE_BINARY!, ["serve", "--hostname", "127.0.0.1", "--port", String(enginePort)], {
      cwd: workspace,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k"), OPENCODE_SERVER_PASSWORD: PASSWORD, OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers }) },
      stdio: "ignore",
    });
    base = `http://127.0.0.1:${enginePort}`;
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await fetch(`${base}/api/info`, { headers: { authorization } }).catch(() => undefined))?.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("The engine did not start");
  }, 30000);

  afterAll(() => {
    engine?.kill();
    mock?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("runs the pinned engine version", () => {
    expect(execFileSync(ENGINE_BINARY!, ["--version"]).toString().trim()).toBe(`opencode v${DEFAULT_ENGINE_VERSION}`);
  });

  it("completes a reasoning, text and tool answer after the event stream is cut", async () => {
    let streams = 0;
    const call = async (_server: OpencodeServer, directory: string, path: string, init: RequestInit = {}) => {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(`${base}${path}${separator}directory=${encodeURIComponent(directory)}`, { ...init, headers: { authorization, "content-type": "application/json", ...init.headers } });
      if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
      return path === "/api/event" && ++streams === 1 ? cutAfter(response, "Before the tool.") : response;
    };
    const server = { baseUrl: base, authorization, startedAt: 0 } as OpencodeServer;
    const pool = { servers: new Map(), secrets: () => [], call, callJson: async (...args: Parameters<typeof call>) => (await call(...args)).json(), post: (target: OpencodeServer, directory: string, path: string, body?: unknown) => call(target, directory, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }), serverFor: async () => server, stopAll: async () => undefined, onStop: () => undefined } as unknown as ServerPool;
    server.pool = pool;

    const created = await (await call(server, workspace, "/api/session", { method: "POST", body: JSON.stringify({ location: { directory: workspace }, model: { id: "mock-ok", providerID: "mock" } }) })).json();
    const sessionId: string = created.data.id;
    const scope = { boardId: "b", nodeId: "n", workspacePath: workspace, files: [], signal: new AbortController().signal, setRuntimeRef: () => undefined, waitForAnswer: async () => "" } as unknown as RunScope;

    const texts = new Map<string, string>();
    const types: string[] = [];
    for await (const event of createOpencode2Runtime({ id: "opencode2", pool }).execute({ server, directory: workspace, sessionId }, "multipart please", scope)) {
      const native = event as { type: string; partId?: string; delta?: string };
      types.push(native.type);
      if (native.partId && native.delta !== undefined && (native.type === "text" || native.type === "reasoning")) texts.set(native.partId, (texts.get(native.partId) ?? "") + native.delta);
    }

    expect(streams).toBe(1);
    expect(types.at(-1)).toBe("idle");
    expect([...texts.values()].sort()).toEqual(["After the tool.", "Before the tool. ", "Thinking first."]);
    expect([...texts.keys()].map((key) => key.split(":").slice(1).join(":")).sort()).toEqual(["reasoning:0", "text:0", "text:0"]);
  }, 30000);
});
