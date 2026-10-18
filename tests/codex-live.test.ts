import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAnswers, type RunEvent } from "@branchboard/core";
import { createLimitsStore } from "../packages/server/src/limits";
import type { RunScope } from "../packages/server/src/run/types";
import { createCodexRuntime } from "../packages/server/src/runtimes/codex";

const executable = process.env.BRANCHBOARD_LIVE_CODEX;
const MOCK_PORT = 47812;

type Step = { text: string } | { items: unknown[] };

const call = (id: number, name: string, args: unknown, namespace?: string) => ({ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args) });

const sse = (events: object[]) => events.map((event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

describe.skipIf(!executable)("codex runtime against a real codex app-server", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-codex-live-"));
  const codexHome = join(root, "codex-home");
  const workspacePath = join(root, "work");
  const script: Step[] = [];
  const modelInputs: any[] = [];
  let server: Server;

  const runtime = createCodexRuntime({
    locate: () => ({ path: executable, searched: [] }),
    environment: () => ({ ...process.env, CODEX_HOME: codexHome }),
    limits: createLimitsStore().of("codex"),
  });

  beforeAll(async () => {
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, "a.txt"), "hello\n");
    execFileSync("git", ["init", "-q", "."], { cwd: workspacePath });
    writeFileSync(
      join(codexHome, "config.toml"),
      ['model = "mock-model"', 'model_provider = "mock"', "suppress_unstable_features_warning = true", "[model_providers.mock]", 'name = "mock"', `base_url = "http://127.0.0.1:${MOCK_PORT}/v1"`, 'wire_api = "responses"', "supports_websockets = false", "request_max_retries = 0", "stream_max_retries = 0"].join("\n"),
    );
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        modelInputs.push(JSON.parse(body).input);
        const step = script.shift() ?? { text: "spare" };
        const id = `resp_${modelInputs.length}`;
        const items = "items" in step ? step.items : [{ type: "message", role: "assistant", id: `msg_${modelInputs.length}`, content: [{ type: "output_text", text: step.text }] }];
        const events: object[] = [{ type: "response.created", response: { id } }];
        for (const item of items as any[]) {
          events.push({ type: "response.output_item.added", item, output_index: 0 });
          if (item.type === "message") events.push({ type: "response.output_text.delta", delta: item.content[0].text, item_id: item.id, output_index: 0, content_index: 0 });
          events.push({ type: "response.output_item.done", item, output_index: 0 });
        }
        events.push({ type: "response.completed", response: { id, usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 55 } } });
        response.writeHead(200, { "content-type": "text/event-stream" }).end(sse(events));
      });
    });
    await new Promise<void>((resolve) => server.listen(MOCK_PORT, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await runtime.forgetCaches?.();
    server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const queue = (...steps: Step[]) => script.splice(0, script.length, ...steps);

  const makeScope = (answer: (requestId: string) => string | undefined = () => undefined, overrides: Partial<RunScope> = {}) => {
    const controller = new AbortController();
    const references: { sessionId: string; lastMessageId?: string }[] = [];
    const scope: RunScope = {
      boardId: "b",
      nodeId: "n",
      workspacePath,
      files: [],
      signal: controller.signal,
      setRuntimeRef: (reference) => void references.push(reference),
      waitForAnswer: async (requestId) => answer(requestId) ?? new Promise(() => undefined),
      ...overrides,
    };
    return { scope, controller, references };
  };

  const run = async (scope: RunScope, input: string, plan = { missingTurns: [] } as Parameters<typeof runtime.openSession>[0], onEvent: (event: RunEvent) => void = () => undefined) => {
    const handle = await runtime.openSession(plan, scope);
    const events: RunEvent[] = [];
    for await (const native of runtime.execute(handle, input, scope)) {
      const mapped = runtime.eventMap[native.type]?.(native, scope) ?? [];
      mapped.forEach(onEvent);
      events.push(...mapped);
    }
    return { events, handle };
  };

  const answerText = (events: RunEvent[]) => events.map((event) => (event.type === "part.delta" && event.partType === "text" ? event.text : "")).join("");

  it("reports a healthy catalog for the mock provider", async () => {
    const catalog = await runtime.catalog(workspacePath);
    expect(catalog.health.ok).toBe(true);
    expect(catalog.health.detail).toMatch(/^found codex \d+\.\d+\.\d+/);
  });

  it("runs a turn, then forks it so the child sees the parent's conversation", async () => {
    queue({ text: "Parent answer" }, { text: "Child answer" });
    const parent = makeScope();
    const first = await run(parent.scope, "Parent question");
    expect(answerText(first.events)).toBe("Parent answer");
    expect(first.events.at(-1)).toEqual({ type: "done" });
    const reference = parent.references.at(-1)!;
    const child = makeScope();
    const second = await run(child.scope, "Child question", { spine: { nodeId: "p", runtimeRef: reference }, missingTurns: [] });
    expect(answerText(second.events)).toBe("Child answer");
    const sent = JSON.stringify(modelInputs.at(-1));
    expect(sent).toContain("Parent question");
    expect(sent).toContain("Parent answer");
    expect(sent).toContain("Child question");
    await runtime.dropSession!(child.references.at(-1)!, workspacePath);
    await runtime.dropSession!(reference, workspacePath);
  });

  it("asks a question on the board and returns the answer to the model", async () => {
    queue({ items: [call(1, "request_user_input", { questions: [{ id: "color", header: "Color", question: "Which color?", options: [{ label: "Blue", description: "Calm" }, { label: "Red", description: "Bold" }] }] })] }, { text: "Noted" });
    const asked: RunEvent[] = [];
    const { scope } = makeScope(() => encodeAnswers([["Red"]]));
    const { events } = await run(scope, "Ask me", undefined, (event) => event.type === "request.opened" && asked.push(event));
    expect(asked[0]).toMatchObject({ request: { kind: "question", questions: [{ question: "Which color?", header: "Color" }] } });
    expect(JSON.stringify(modelInputs.at(-1))).toContain('{\\"answers\\":{\\"color\\":{\\"answers\\":[\\"Red\\"]}}}');
    expect(answerText(events)).toBe("Noted");
  });

  it("asks before a command in manual mode and ends the turn when the command is rejected", async () => {
    const callsBefore = modelInputs.length;
    queue({ items: [call(2, "exec_command", { cmd: "touch made.txt" })] });
    const { scope } = makeScope(() => "reject", { permissionMode: "manual" });
    const { events } = await run(scope, "Make a file");
    expect(events.find((event) => event.type === "request.opened")).toMatchObject({ request: { kind: "approval", title: "Allow command?", detail: "touch made.txt" } });
    expect(events.find((event) => event.type === "tool.started")).toMatchObject({ tool: "bash", input: { command: "touch made.txt" } });
    expect(events.find((event) => event.type === "tool.done")).toMatchObject({ isError: true });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(modelInputs.length - callsBefore).toBe(1);
  });

  it("steers and stops a running turn", async () => {
    queue({ items: [call(3, "exec_command", { cmd: "touch waiting.txt" })] });
    const live = makeScope(undefined, { permissionMode: "manual" });
    const opened: RunEvent[] = [];
    let handleOf: Awaited<ReturnType<typeof runtime.openSession>> | undefined;
    const handle = await runtime.openSession({ missingTurns: [] }, live.scope);
    handleOf = handle;
    const events: RunEvent[] = [];
    const running = (async () => {
      for await (const native of runtime.execute(handle, "Wait for me", live.scope)) {
        const mapped = runtime.eventMap[native.type]?.(native, live.scope) ?? [];
        mapped.filter((event) => event.type === "request.opened").forEach((event) => opened.push(event));
        events.push(...mapped);
      }
    })();
    const deadline = Date.now() + 20000;
    while (opened.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened).toHaveLength(1);
    await runtime.control!(handleOf, { type: "followUp", text: "Also say hi" });
    live.controller.abort();
    await running;
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("writes a title in a throwaway thread", async () => {
    queue({ text: " Trip plan " });
    const { scope } = makeScope();
    expect(await runtime.generateText!("Plan a trip to Rome", "title", scope, new AbortController().signal)).toBe("Trip plan");
    expect(JSON.stringify(modelInputs.at(-1))).toContain("You write very short titles");
  });

  it("forks and compacts a thread after the app-server restarts", async () => {
    queue({ text: "Before restart" }, { text: "Summary" }, { text: "After restart" });
    const parent = makeScope();
    await run(parent.scope, "Remember 42");
    const reference = parent.references.at(-1)!;
    await runtime.forgetCaches?.();
    await runtime.compact!(reference, workspacePath);
    const child = makeScope();
    const { events } = await run(child.scope, "What number?", { spine: { nodeId: "p", runtimeRef: reference }, missingTurns: [] });
    expect(answerText(events)).toBe("After restart");
  });
});
