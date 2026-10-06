import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeRollOf, ANSWER_FORMATS_GUIDE, answerText, encodeAnswers, REJECTED_ANSWER, satelliteIdsOf, type BoardView, type GraphNode } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { createLimitsStore } from "../packages/server/src/limits";
import { createChannel } from "../packages/server/src/run/channel";
import { createLimiter } from "../packages/server/src/run/limiter";
import { createClaudeRuntime, TOOL_TIMEOUT_MS } from "../packages/server/src/runtimes/claude";
import { createApprovalBroker, type ApprovalHandler } from "../packages/server/src/runtimes/claudeApprovals";
import { locateClaude } from "../packages/server/src/runtimes/claudeLocator";
import { attachmentDirectories, buildClaudeArguments, buildUserMessage, createStreamState, supportsSubagentText, translateClaudeMessage } from "../packages/server/src/runtimes/claudeStream";
import { BUNDLED_COMMANDS, listWorkspaceCommands, withBundledCommands } from "../packages/server/src/runtimes/claudeCommands";
import { fakeRuntime } from "../packages/server/src/runtimes/fake";
import { opencodeRuntime } from "../packages/server/src/runtimes/opencode";
import type { ProcessExit, RunningProcess } from "../packages/server/src/runtimes/spawnProcess";

const PORT = 47124;
const HOST = `127.0.0.1:${PORT}`;
const EXECUTABLE = "C:\\tools\\claude.exe";

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for condition");
};

class ScriptedProcess implements RunningProcess {
  input = "";
  wasKilled = false;
  private readonly channel = createChannel<string>();
  private finishExit!: (exit: ProcessExit) => void;
  readonly lines = this.channel.iterator;
  readonly exit = new Promise<ProcessExit>((resolve) => (this.finishExit = resolve));

  writeInput(text: string) {
    this.input += text;
  }
  endInput() {}
  emit(message: unknown) {
    this.channel.push(JSON.stringify(message));
  }
  emitLine(text: string) {
    this.channel.push(text);
  }
  finish(code: number | null = 0, stderrTail = "") {
    this.channel.close();
    this.finishExit({ code, stderrTail });
  }
  kill() {
    this.wasKilled = true;
    this.finish(null);
  }
}

interface Launch {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  process: ScriptedProcess;
}

const messageStart = (messageId: string) => ({ type: "stream_event", event: { type: "message_start", message: { id: messageId } } });
const textDelta = (index: number, text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });
const initMessage = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId });
const successResult = (text: string) => ({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } });
const toolUse = (messageId: string, toolId: string, name: string, input: unknown) => ({ type: "assistant", message: { id: messageId, content: [{ type: "tool_use", id: toolId, name, input }] } });
const toolResult = (toolId: string, content: unknown, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content, is_error: isError }] } });

const answerWith = (process: ScriptedProcess, sessionId: string, text: string, messageId = "m1") => {
  process.emit(initMessage(sessionId));
  process.emit(messageStart(messageId));
  process.emit(textDelta(0, text));
  process.emit(successResult(text));
};

describe("argument building", () => {
  const base = { sessionId: "11111111-1111-4111-8111-111111111111", mcpConfigPath: "C:\\tmp\\run.mcp.json", addDirectories: [] };

  it("starts a new session for a root node", () => {
    const args = buildClaudeArguments(base);
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--resume");
    expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--include-partial-messages", "--permission-prompt-tool", "mcp__branchboard__approve"]));
    expect(args.slice(args.indexOf("--mcp-config"), args.indexOf("--mcp-config") + 2)).toEqual(["--mcp-config", base.mcpConfigPath]);
  });

  it("forks the parent session for a child node", () => {
    const args = buildClaudeArguments({ ...base, resumeFrom: "parent-session" });
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 3)).toEqual(["--resume", "parent-session", "--fork-session"]);
  });

  it("omits the model and agent when the default is chosen", () => {
    const args = buildClaudeArguments({ ...base, model: "default", agent: "default" });
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--agent");
    expect(buildClaudeArguments({ ...base, model: "opus", agent: "reviewer" })).toEqual(expect.arrayContaining(["--model", "opus", "--agent", "reviewer"]));
  });

  it("passes effort and permission mode only when chosen", () => {
    const args = buildClaudeArguments({ ...base, effort: "default", permissionMode: "default" });
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--permission-mode");
    expect(buildClaudeArguments({ ...base, effort: "high", permissionMode: "plan" })).toEqual(expect.arrayContaining(["--effort", "high", "--permission-mode", "plan"]));
  });

  it("never lets a node bypass permissions", () => {
    expect(() => buildClaudeArguments({ ...base, permissionMode: "bypassPermissions" })).toThrow(/not available/);
    expect(() => buildClaudeArguments({ ...base, effort: "high; calc" })).toThrow(/unsafe effort/);
  });

  it("forwards subagent text only when asked and only for versions that know the flag", () => {
    expect(buildClaudeArguments(base)).not.toContain("--forward-subagent-text");
    expect(buildClaudeArguments({ ...base, forwardSubagentText: true })).toContain("--forward-subagent-text");
    expect(supportsSubagentText("2.1.211 (Claude Code)")).toBe(true);
    expect(supportsSubagentText("2.1.300")).toBe(true);
    expect(supportsSubagentText("2.2.0")).toBe(true);
    expect(supportsSubagentText("3.0.1")).toBe(true);
    expect(supportsSubagentText("2.1.210")).toBe(false);
    expect(supportsSubagentText("1.9.999")).toBe(false);
    expect(supportsSubagentText("unknown")).toBe(false);
  });

  it("refuses values that could break out of a command line", () => {
    expect(() => buildClaudeArguments({ ...base, model: "opus & calc" })).toThrow(/unsafe model/);
    expect(() => buildClaudeArguments({ ...base, agent: "a\"b" })).toThrow(/unsafe agent/);
    expect(() => buildClaudeArguments({ ...base, resumeFrom: "x; rm" })).toThrow(/unsafe session id/);
  });
});

describe("user message", () => {
  const files = [
    { name: "shot.png", mime: "image/png", path: "C:\\store\\a1" },
    { name: "notes.pdf", mime: "application/pdf", path: "C:\\store\\b2" },
  ];

  it("sends images as content blocks and other files as path references", () => {
    const line = buildUserMessage("look", files, (path) => `bytes-of-${path}`);
    expect(line.endsWith("\n")).toBe(true);
    const message = JSON.parse(line);
    expect(message.type).toBe("user");
    const [text, image] = message.message.content;
    expect(text.text).toContain("look");
    expect(text.text).toContain("notes.pdf: C:\\store\\b2");
    expect(text.text).not.toContain("shot.png");
    expect(image).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "bytes-of-C:\\store\\a1" } });
  });

  it.runIf(process.platform === "win32")("grants access to the folders of referenced files only", () => {
    expect(attachmentDirectories(files)).toEqual(["C:\\store"]);
    expect(attachmentDirectories([files[0]])).toEqual([]);
  });
});

describe("stream translation", () => {
  const translate = (messages: unknown[]) => {
    const state = createStreamState();
    return { natives: messages.flatMap((message) => translateClaudeMessage(message, state)), state };
  };

  it("turns partial messages into text and reasoning deltas without duplicating the final message", () => {
    const { natives } = translate([
      initMessage("s1"),
      messageStart("m1"),
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } },
      textDelta(1, "Hel"),
      textDelta(1, "lo"),
      { type: "assistant", message: { id: "m1", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello" }] } },
      successResult("Hello"),
    ]);
    expect(natives.map((native) => native.type)).toEqual(["session", "reasoning", "text", "text", "usage", "done"]);
    expect(natives[2]).toMatchObject({ partId: "m1:1", delta: "Hel" });
    expect(natives[4]).toMatchObject({ inputTokens: 15, outputTokens: 7 });
  });

  it("falls back to the final message when nothing was streamed", () => {
    const { natives } = translate([{ type: "assistant", message: { id: "m9", content: [{ type: "text", text: "whole answer" }] } }]);
    expect(natives).toEqual([{ type: "text", partId: "m9:0", delta: "whole answer" }]);
  });

  it("starts each tool once and finishes it from the tool result", () => {
    const call = toolUse("m2", "t1", "Bash", { command: "ls", description: "Lists files" });
    const { natives } = translate([call, call, toolResult("t1", [{ type: "text", text: "a.txt" }]), toolResult("t2", "boom", true)]);
    expect(natives).toEqual([
      { type: "tool-start", partId: "tool:t1", tool: "Bash", description: "Lists files", input: { command: "ls", description: "Lists files" } },
      { type: "tool-done", partId: "tool:t1", output: "a.txt", isError: false },
      { type: "tool-done", partId: "tool:t2", output: "boom", isError: true },
    ]);
  });

  it("names MCP tools as server_tool and describes calls without a description", () => {
    const { natives } = translate([toolUse("m3", "t3", "mcp__db__query", { query: "select 1" })]);
    expect(natives[0]).toMatchObject({ tool: "db_query", description: "select 1" });
  });

  it("routes subagent traffic to its own key instead of the main answer", () => {
    const { natives } = translate([{ ...toolUse("m4", "t4", "Bash", { command: "x" }), parent_tool_use_id: "outer" }]);
    expect(natives).toEqual([{ type: "sub", key: "outer", inner: expect.objectContaining({ type: "tool-start", tool: "Bash" }) }]);
  });

  it("starts a subagent when the Task tool is used and ends it when the tool returns", () => {
    const { natives } = translate([
      toolUse("m5", "task-1", "Task", { description: "Find the bug", subagent_type: "explorer" }),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "task-1", content: "done" }] } },
    ]);
    expect(natives.map((native) => native.type)).toEqual(["tool-start", "subagent-start", "tool-done", "subagent-done"]);
    expect(natives[1]).toMatchObject({ key: "task-1", title: "Find the bug", agent: "explorer" });
  });

  it("turns TodoWrite into a todo list instead of a tool card", () => {
    const { natives } = translate([toolUse("m6", "todo-1", "TodoWrite", { todos: [{ content: "Write tests", status: "in_progress" }] })]);
    expect(natives).toEqual([{ type: "todos", items: [{ content: "Write tests", status: "in_progress" }] }]);
  });

  it("reports an error result as a failure with the CLI's message", () => {
    const { natives, state } = translate([{ type: "result", subtype: "success", is_error: true, result: "Not logged in" }]);
    expect(natives).toEqual([{ type: "failure", message: "Not logged in" }]);
    expect(state.isFinished).toBe(true);
    expect(translate([{ type: "result", subtype: "error_max_turns", is_error: false }]).natives[0]).toMatchObject({ type: "failure" });
  });

  it("reports the context size of the last call and the window of the main model", () => {
    const { natives } = translate([
      { type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-4-5-20251001" },
      { type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 30000, cache_read_input_tokens: 700, output_tokens: 4 } } },
      { ...successResult("ok"), modelUsage: { "claude-haiku-4-5-20251001": { contextWindow: 200000 }, "claude-opus-5-5": { contextWindow: 1000000 } } },
    ]);
    expect(natives.find((native) => native.type === "usage")).toMatchObject({ contextTokens: 30710, contextWindow: 200000 });
  });

  it("splits cache reads and writes, and keeps the first call's split", () => {
    const { natives } = translate([
      { type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 2, cache_creation_input_tokens: 1500, cache_read_input_tokens: 180000, output_tokens: 4 } } },
      { type: "assistant", message: { id: "m2", content: [], usage: { input_tokens: 2, cache_creation_input_tokens: 9000, cache_read_input_tokens: 181500, output_tokens: 4 } } },
      { ...successResult("ok"), usage: { input_tokens: 4, cache_creation_input_tokens: 10500, cache_read_input_tokens: 361500, output_tokens: 8 } },
    ]);
    expect(natives.find((native) => native.type === "usage")).toMatchObject({
      inputTokens: 372004,
      cacheReadTokens: 361500,
      cacheCreationTokens: 10500,
      firstCallCacheReadTokens: 180000,
      firstCallCacheCreationTokens: 1500,
    });
  });

  it("hands rate limit info over untouched", () => {
    const info = { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.44, resetsAt: 1791054000 } } };
    expect(translate([{ type: "rate_limit_event", rate_limit_info: info }]).natives).toEqual([{ type: "limits", info }]);
  });

  it("skips unknown and malformed messages", () => {
    expect(translate([{ type: "something_new" }, null, "text"]).natives).toEqual([]);
  });
});

describe("limits store", () => {
  const sample = {
    status: "allowed",
    resetsAt: 1791054000,
    rateLimitType: "five_hour",
    unifiedWindows: { five_hour: { utilization: 0.44, resetsAt: 1791054000 }, seven_day: { utilization: 0.15, resetsAt: 1791540000 }, broken: { utilization: "x" } },
  };

  it("starts empty and keeps the latest windows with a timestamp", () => {
    const store = createLimitsStore();
    expect(store.current()).toBeUndefined();
    store.record(sample);
    expect(store.current()).toMatchObject({ status: "allowed", windows: [{ id: "five_hour", utilization: 0.44, resetsAt: 1791054000 }, { id: "seven_day", utilization: 0.15, resetsAt: 1791540000 }] });
    expect(store.current()?.updatedAt).toBeGreaterThan(0);
  });

  it("ignores info that is not an object", () => {
    const store = createLimitsStore();
    store.record(undefined);
    store.record("nope");
    expect(store.current()).toBeUndefined();
  });

  it("appends every reading with its board and node to the history file", () => {
    const directory = mkdtempSync(join(tmpdir(), "branchboard-limits-"));
    const historyPath = join(directory, "limits-history.jsonl");
    const store = createLimitsStore(join(directory, "limits.json"), historyPath);
    store.record(sample, { boardId: "board-1", nodeId: "node-1" });
    store.record({ ...sample, unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1791054000 } } });
    const records = readFileSync(historyPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ boardId: "board-1", nodeId: "node-1", status: "allowed", windows: [{ id: "five_hour", utilization: 0.44 }, { id: "seven_day", utilization: 0.15 }] });
    expect(records[1]).toMatchObject({ windows: [{ id: "five_hour", utilization: 0.5 }] });
    expect(records[1].boardId).toBeUndefined();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("approval broker", () => {
  const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });
  const notification = (method: string) => ({ jsonrpc: "2.0", method });

  it("answers the handshake and lists one approve tool", async () => {
    const broker = createApprovalBroker();
    const { secret } = broker.register(async () => ({ behavior: "deny", message: "no" }));
    const initialized = await broker.handle(secret, rpc("initialize", { protocolVersion: "2025-06-18" }));
    expect(initialized.body).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    expect((await broker.handle(secret, notification("notifications/initialized"))).status).toBe(202);
    const listed = (await broker.handle(secret, rpc("tools/list"))).body as any;
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(["approve"]);
    expect((await broker.handle(secret, rpc("ping"))).body).toMatchObject({ result: {} });
  });

  it("relays a call to the handler and wraps the verdict as text content", async () => {
    const broker = createApprovalBroker();
    const seen: unknown[] = [];
    const handler: ApprovalHandler = async (call) => (seen.push(call), { behavior: "allow", updatedInput: call.input });
    const { secret } = broker.register(handler);
    const reply = await broker.handle(secret, rpc("tools/call", { name: "approve", arguments: { tool_name: "Read", input: { file_path: "a.txt" }, tool_use_id: "u1" } }));
    expect(seen).toEqual([{ toolName: "Read", input: { file_path: "a.txt" }, toolUseId: "u1" }]);
    const text = (reply.body as any).result.content[0].text;
    expect(JSON.parse(text)).toEqual({ behavior: "allow", updatedInput: { file_path: "a.txt" } });
  });

  it("denies when the handler throws and rejects bad calls", async () => {
    const broker = createApprovalBroker();
    const { secret } = broker.register(async () => {
      throw new Error("boom");
    });
    const denied = await broker.handle(secret, rpc("tools/call", { name: "approve", arguments: { tool_name: "Bash", input: {} } }));
    expect(JSON.parse((denied.body as any).result.content[0].text)).toMatchObject({ behavior: "deny", message: expect.stringContaining("boom") });
    expect(((await broker.handle(secret, rpc("tools/call", { name: "other", arguments: {} }))).body as any).error.code).toBe(-32602);
    expect(((await broker.handle(secret, rpc("nope"))).body as any).error.code).toBe(-32601);
  });

  it("serves batches and forgets disposed secrets", async () => {
    const broker = createApprovalBroker();
    const registration = broker.register(async () => ({ behavior: "deny", message: "no" }));
    const batch = await broker.handle(registration.secret, [rpc("ping", undefined, 1), notification("notifications/initialized"), rpc("ping", undefined, 2)]);
    expect((batch.body as unknown[]).length).toBe(2);
    expect((await broker.handle("unknown-secret", rpc("ping"))).status).toBe(404);
    registration.dispose();
    expect(broker.registeredCount()).toBe(0);
    expect((await broker.handle(registration.secret, rpc("ping"))).status).toBe(404);
  });
});

describe("channel and limiter", () => {
  it("delivers queued and later items in order and ends when closed", async () => {
    const channel = createChannel<number>();
    channel.push(1);
    const collected: number[] = [];
    const reading = (async () => {
      for await (const item of channel.iterator) collected.push(item);
    })();
    channel.push(2);
    channel.push(3);
    channel.close();
    channel.push(4);
    await reading;
    expect(collected).toEqual([1, 2, 3]);
  });

  it("runs at most the limit and lets waiters in as slots free", async () => {
    const limiter = createLimiter(2);
    const signal = new AbortController().signal;
    const first = await limiter.acquire(signal);
    const second = await limiter.acquire(signal);
    let thirdGranted = false;
    const third = limiter.acquire(signal).then((release) => ((thirdGranted = true), release));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdGranted).toBe(false);
    first!();
    first!();
    const thirdRelease = await third;
    expect(thirdGranted).toBe(true);
    expect(limiter.activeCount()).toBe(2);
    second!();
    thirdRelease!();
    expect(limiter.activeCount()).toBe(0);
  });

  it("gives up waiting when aborted", async () => {
    const limiter = createLimiter(1);
    const holder = await limiter.acquire(new AbortController().signal);
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    controller.abort();
    expect(await waiting).toBeUndefined();
    holder!();
    expect(limiter.activeCount()).toBe(0);
  });
});

describe("claude locator", () => {
  it("prefers claude.exe and finds the standard install folder", () => {
    const standard = join("C:\\Users\\R", ".local", "bin", "claude.exe");
    const located = locateClaude({ platform: "win32", env: { PATH: "C:\\Windows" }, home: "C:\\Users\\R", isFile: (path) => path === standard });
    expect(located.path).toBe(standard);
  });

  it("honours the override variable and reports a bad one", () => {
    const environment = (isFile: boolean) => ({ platform: "linux" as const, env: { BRANCHBOARD_CLAUDE_PATH: "/opt/claude" }, home: "/home/r", isFile: () => isFile });
    expect(locateClaude(environment(true)).path).toBe("/opt/claude");
    expect(locateClaude(environment(false)).path).toBeUndefined();
  });
});

describe("title generation", () => {
  const launched: Launch[] = [];
  const titleRuntime = (finishWith: (launch: Launch, count: number) => void) =>
    createClaudeRuntime({
      serverUrl: "http://x",
      locate: () => ({ path: EXECUTABLE, searched: [] }),
      temporaryDirectory: join(tmpdir(), "branchboard-title-test"),
      launch: (_executable, args, options) => {
        const launch: Launch = { args, cwd: options.cwd, env: options.env, process: new ScriptedProcess() };
        launched.push(launch);
        queueMicrotask(() => finishWith(launch, launched.length));
        return launch.process;
      },
    });
  const scope = { boardId: "b", nodeId: "n", workspacePath: process.cwd(), files: [], signal: new AbortController().signal, setRuntimeRef: () => undefined, waitForAnswer: async () => "reject" };

  it("runs a lean, cheap, tool-less one-shot call outside the workspace", async () => {
    launched.length = 0;
    const runtime = titleRuntime(({ process }) => {
      process.emitLine("Banana Facts");
      process.finish(0);
    });
    expect(await runtime.generateTitle!("title this", scope, new AbortController().signal)).toBe("Banana Facts");
    const [{ args, cwd, process }] = launched;
    expect(args).toEqual(expect.arrayContaining(["-p", "--model", "haiku", "--no-session-persistence", "--max-turns", "1", "--safe-mode"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--resume");
    expect(cwd).not.toBe(scope.workspacePath);
    expect(process.input).toBe("title this");
  });

  it("falls back to the older lean options when the CLI does not know --safe-mode", async () => {
    launched.length = 0;
    const runtime = titleRuntime((launch, count) => {
      if (count === 1) return launch.process.finish(1, "error: unknown option '--safe-mode'");
      launch.process.emitLine("Fallback Name");
      launch.process.finish(0);
    });
    expect(await runtime.generateTitle!("title this", scope, new AbortController().signal)).toBe("Fallback Name");
    expect(launched[1].args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--disable-slash-commands"]));
    expect(launched[1].args).not.toContain("--safe-mode");
  });

  it("reports a real failure instead of retrying it", async () => {
    launched.length = 0;
    const runtime = titleRuntime(({ process }) => process.finish(1, "Not logged in"));
    await expect(runtime.generateTitle!("title this", scope, new AbortController().signal)).rejects.toThrow(/Not logged in/);
    expect(launched).toHaveLength(1);
  });
});

describe("runtime availability", () => {
  const workspace = process.cwd();
  const located = { path: EXECUTABLE, searched: [] };

  it("explains a missing executable", async () => {
    const runtime = createClaudeRuntime({ serverUrl: "http://x", locate: () => ({ searched: [] }) });
    const catalog = await runtime.catalog(workspace);
    expect(catalog.health.ok).toBe(false);
    expect(catalog.health.detail).toContain("BRANCHBOARD_CLAUDE_PATH");
  });

  it("reports the version and offers models and workspace agents when healthy", async () => {
    const runtime = createClaudeRuntime({ serverUrl: "http://x", locate: () => located, probeVersion: async () => "2.9.9", listAgents: () => ["reviewer"] });
    const catalog = await runtime.catalog(workspace);
    expect(catalog.health).toEqual({ ok: true, detail: "found claude 2.9.9" });
    expect(catalog.agents).toEqual(["default", "reviewer"]);
    expect(catalog.models.map((model) => model.id)).toEqual(["default", "sonnet", "opus", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]);
    expect(catalog.models.every((model) => model.efforts?.includes("high"))).toBe(true);
    expect(catalog.permissionModes?.map((mode) => mode.id)).toEqual(["manual", "plan", "acceptEdits", "auto", "dontAsk"]);
  });

  it("lists the workspace's slash commands with their descriptions and templates", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchboard-commands-"));
    mkdirSync(join(root, ".claude", "commands"), { recursive: true });
    writeFileSync(join(root, ".claude", "commands", "review.md"), "---\ndescription: Review the change\nmodel: haiku\n---\nReview $ARGUMENTS carefully.\n");
    writeFileSync(join(root, ".claude", "commands", "plain.md"), "Just do it.");
    writeFileSync(join(root, ".claude", "commands", "notes.txt"), "ignored");
    try {
      expect(listWorkspaceCommands(root).sort((left, right) => left.name.localeCompare(right.name))).toEqual([
        { name: "plain", description: undefined, template: "Just do it." },
        { name: "review", description: "Review the change", template: "Review $ARGUMENTS carefully." },
      ]);
      expect(listWorkspaceCommands(join(root, "missing"))).toEqual([]);
      const runtime = createClaudeRuntime({ serverUrl: "http://x", locate: () => located, probeVersion: async () => "2.9.9", listCommands: () => [{ name: "ship", template: "Ship it" }] });
      expect((await runtime.catalog(root)).commands).toEqual([{ name: "ship", template: "Ship it" }, ...BUNDLED_COMMANDS]);
      expect(withBundledCommands([{ name: "security-review", template: "Mine" }])).toEqual([{ name: "security-review", template: "Mine" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports diagnostics without exposing anything but the sign-in method", async () => {
    const limiter = createLimiter(2);
    const runtime = createClaudeRuntime({
      serverUrl: "http://x",
      locate: () => located,
      probeVersion: async () => "2.1.300",
      probeAuth: async () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com", token: "secret" }),
      limiter,
    });
    const diagnostics = await runtime.diagnostics!(workspace);
    expect(diagnostics).toEqual({ executable: EXECUTABLE, processSlots: { active: 0, limit: 2, waiting: 0 }, supportsSubagentText: true, authMethod: "claude.ai", isSignedIn: true });
    const broken = createClaudeRuntime({ serverUrl: "http://x", locate: () => located, probeVersion: async () => "1.0.0", probeAuth: async () => "not json", limiter });
    expect(await broken.diagnostics!(workspace)).toMatchObject({ supportsSubagentText: false });
  });

  it("says when a run is waiting for one of the process slots", async () => {
    const limiter = createLimiter(1);
    const holder = await limiter.acquire(new AbortController().signal);
    expect(limiter.isFull()).toBe(true);
    const runtime = createClaudeRuntime({ serverUrl: "http://x", locate: () => located, probeVersion: async () => "2.9.9", limiter, launch: () => new ScriptedProcess() });
    const controller = new AbortController();
    const waitingStates: boolean[] = [];
    const scope = { boardId: "b", nodeId: "n", workspacePath: workspace, files: [], signal: controller.signal, setRuntimeRef: () => undefined, setWaitingForSlot: (isWaiting: boolean) => waitingStates.push(isWaiting), waitForAnswer: async () => "reject" };
    const handle = await runtime.openSession({ missingTurns: [] }, scope);
    const started = runtime.execute(handle, "hello", scope)[Symbol.asyncIterator]().next();
    await waitFor(() => limiter.waitingCount() === 1);
    expect(waitingStates).toEqual([true]);
    controller.abort();
    await started;
    expect(waitingStates).toEqual([true, false]);
    holder!();
    expect(limiter.waitingCount()).toBe(0);
  });

  it("reports an executable that will not run", async () => {
    const runtime = createClaudeRuntime({
      serverUrl: "http://x",
      locate: () => located,
      probeVersion: async () => {
        throw new Error("spawn failed");
      },
    });
    const catalog = await runtime.catalog(workspace);
    expect(catalog.health.ok).toBe(false);
    expect(catalog.health.detail).toContain("spawn failed");
  });
});

describe("runs through the board", () => {
  const directory = mkdtempSync(join(tmpdir(), "branchboard-claude-"));
  const launches: Launch[] = [];
  const approvals = createApprovalBroker();
  let server: ReturnType<typeof createApp>;
  let boardId = "";

  const request = async (path: string, body?: unknown, headers: Record<string, string> = { host: HOST, "content-type": "application/json" }) => {
    const response = await server.app.request(`http://${HOST}${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : undefined };
  };
  const command = (body: Record<string, unknown>) => request("/api/commands", body, { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" });
  const view = async (): Promise<BoardView> => (await request(`/api/boards/${boardId}/graph`)).json;
  const nodeOf = async (nodeId: string): Promise<GraphNode> => (await view()).graph.nodes[nodeId];
  const waitForStatus = (nodeId: string, status: string) => waitFor(async () => (await nodeOf(nodeId)).status === status);
  const textOf = async (nodeId: string) => {
    const current = await view();
    return answerText(current.parts[nodeId], activeRollOf(current.graph.nodes[nodeId]));
  };
  const openRequests = async () => Object.values((await view()).requests).filter((candidate) => candidate.status === "open");
  const reply = async (prompt: string, parentIds: string[] = []): Promise<string> => (await command({ type: "reply", boardId, prompt, parentIds })).json.nodeId;
  const launchAt = async (index: number): Promise<Launch> => {
    await waitFor(() => launches.length > index);
    return launches[index];
  };
  const callApprove = async (launch: Launch, toolName: string, input: unknown) => {
    const configPath = launch.args[launch.args.indexOf("--mcp-config") + 1];
    const url = new URL(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.branchboard.url);
    const response = await request(url.pathname, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "approve", arguments: { tool_name: toolName, input, tool_use_id: "u" } } });
    return JSON.parse(response.json.result.content[0].text);
  };

  beforeAll(async () => {
    const claude = createClaudeRuntime({
      approvals,
      serverUrl: `http://${HOST}`,
      locate: () => ({ path: EXECUTABLE, searched: [] }),
      probeVersion: async () => "9.9.9",
      temporaryDirectory: join(directory, "mcp"),
      readBase64: () => "",
      suggestsTitles: false,
      launch: (_executable, args, options) => {
        const launch: Launch = { args, cwd: options.cwd, env: options.env, process: new ScriptedProcess() };
        launches.push(launch);
        return launch.process;
      },
    });
    server = createApp({ databasePath: join(directory, "test.db"), security: { port: PORT, extraOrigins: [] }, webRoot: join(directory, "none"), approvals, runtimes: { fake: fakeRuntime, opencode: opencodeRuntime, claude } });
    boardId = (await command({ type: "createBoard", title: "Claude", workspacePath: process.cwd(), mode: "claude" })).json.id;
  });

  afterAll(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses to create a board while the claude command is missing", async () => {
    const missingApp = createApp({ databasePath: join(directory, "missing.db"), security: { port: PORT, extraOrigins: [] }, webRoot: join(directory, "none"), runtimes: { fake: fakeRuntime, opencode: opencodeRuntime, claude: createClaudeRuntime({ serverUrl: "http://x", locate: () => ({ searched: [] }) }) } });
    const response = await missingApp.app.request(`http://${HOST}/api/commands`, { method: "POST", headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" }, body: JSON.stringify({ type: "createBoard", title: "x", workspacePath: process.cwd(), mode: "claude" }) });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("not found");
    missingApp.close();
  });

  it("streams a root node's answer, records the session and passes the environment through", async () => {
    const root = await reply("first question");
    const launch = await launchAt(0);
    expect(launch.args).not.toContain("--resume");
    expect(launch.args.slice(launch.args.indexOf("--permission-mode"), launch.args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "acceptEdits"]);
    expect(launch.args[launch.args.indexOf("--session-id") + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(launch.cwd).toBe(process.cwd());
    await waitFor(() => launch.process.input.length > 0);
    expect(JSON.parse(launch.process.input).message.content[0].text).toContain("first question");
    answerWith(launch.process, "sess-root", "root answer");
    await waitForStatus(root, "done");
    expect(await textOf(root)).toBe("root answer");
    const node = await nodeOf(root);
    expect(node.runtimeRef?.sessionId).toBe("sess-root");
    expect(node.usage).toEqual({ inputTokens: 15, outputTokens: 7, cacheReadTokens: 5, cacheCreationTokens: 0 });
    expect(launch.process.wasKilled).toBe(true);
    const timeoutKeys = ["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "MCP_TOOL_TIMEOUT"];
    const unexpected = Object.keys(launch.env).filter((key) => !(key in process.env) && !timeoutKeys.includes(key));
    expect(unexpected).toEqual([]);
    expect(launch.env.MCP_TOOL_TIMEOUT).toBe(String(TOOL_TIMEOUT_MS));
    expect(launch.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe(String(TOOL_TIMEOUT_MS));
    expect(approvals.registeredCount()).toBe(0);
    expect(readdirSync(join(directory, "mcp"))).toEqual([]);
  });

  it("forks the parent's saved session for a child node", async () => {
    const parent = (await view()).graph.nodes;
    const rootId = Object.values(parent).find((node) => node.prompt === "first question")!.id;
    const child = await reply("follow up", [rootId]);
    const launch = await launchAt(1);
    const args = launch.args;
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 3)).toEqual(["--resume", "sess-root", "--fork-session"]);
    answerWith(launch.process, "sess-child", "child answer");
    await waitForStatus(child, "done");
    expect((await nodeOf(child)).runtimeRef?.sessionId).toBe("sess-child");
  });

  it("pauses on a tool approval and relays the decision to the CLI", async () => {
    const node = await reply("run the tests");
    const launch = await launchAt(2);
    launch.process.emit(initMessage("sess-tool"));
    launch.process.emit(toolUse("m5", "tool-1", "Bash", { command: "npm test", description: "Runs the tests" }));
    const verdict = callApprove(launch, "Bash", { command: "npm test" });
    await waitForStatus(node, "awaiting_approval");
    const [pending] = await openRequests();
    expect(pending).toMatchObject({ kind: "approval", title: "Allow Bash?", detail: "npm test", options: ["once", "always", "reject"] });
    await command({ type: "answerRequest", boardId, requestId: pending.id, answer: "once" });
    expect(await verdict).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
    await waitForStatus(node, "running");
    launch.process.emit(toolResult("tool-1", "all green"));
    answerWith(launch.process, "sess-tool", "tests passed", "m6");
    await waitForStatus(node, "done");
    const tool = (await view()).parts[node].find((part) => part.type === "tool");
    expect(tool?.text).toBe("Runs the tests");
    expect(tool?.meta).toMatchObject({ status: "done", output: "all green" });
  });

  it("denies a rejected tool call", async () => {
    const node = await reply("delete things");
    const launch = await launchAt(3);
    const verdict = callApprove(launch, "Bash", { command: "rm -rf build" });
    await waitForStatus(node, "awaiting_approval");
    const [pending] = await openRequests();
    await command({ type: "answerRequest", boardId, requestId: pending.id, answer: "reject" });
    expect(await verdict).toMatchObject({ behavior: "deny" });
    answerWith(launch.process, "sess-deny", "skipped it");
    await waitForStatus(node, "done");
  });

  it("remembers 'always' for the same command only", async () => {
    const node = await reply("lint twice");
    const launch = await launchAt(4);
    const first = callApprove(launch, "Bash", { command: "npm run lint" });
    await waitForStatus(node, "awaiting_approval");
    const [pending] = await openRequests();
    await command({ type: "answerRequest", boardId, requestId: pending.id, answer: "always" });
    expect((await first).behavior).toBe("allow");
    expect((await callApprove(launch, "Bash", { command: "npm run lint" })).behavior).toBe("allow");
    expect(await openRequests()).toHaveLength(0);
    const other = callApprove(launch, "Bash", { command: "npm publish" });
    await waitFor(async () => (await openRequests()).length === 1);
    const [second] = await openRequests();
    await command({ type: "answerRequest", boardId, requestId: second.id, answer: "reject" });
    expect((await other).behavior).toBe("deny");
    answerWith(launch.process, "sess-always", "done linting");
    await waitForStatus(node, "done");
  });

  it("turns the question tool into a question request and returns the answers", async () => {
    const node = await reply("ask me");
    const launch = await launchAt(5);
    const input = { questions: [{ question: "Which fruit?", header: "Fruit", options: [{ label: "apple" }, { label: "banana", description: "yellow" }], multiSelect: false }, { question: "Toppings?", options: [{ label: "cream" }, { label: "nuts" }], multiSelect: true }] };
    const verdict = callApprove(launch, "AskUserQuestion", input);
    await waitForStatus(node, "awaiting_approval");
    const [pending] = await openRequests();
    expect(pending.kind).toBe("question");
    expect(pending.questions).toHaveLength(2);
    expect(pending.questions?.[1].multiple).toBe(true);
    expect(pending.questions?.[0].options[1]).toEqual({ label: "banana", description: "yellow" });
    await command({ type: "answerRequest", boardId, requestId: pending.id, answer: encodeAnswers([["banana"], ["cream", "nuts"]]) });
    const result = await verdict;
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput.answers).toEqual({ "Which fruit?": "banana", "Toppings?": "cream, nuts" });
    expect(result.updatedInput.questions).toEqual(input.questions);
    answerWith(launch.process, "sess-ask", "thanks");
    await waitForStatus(node, "done");
  });

  it("denies a dismissed question", async () => {
    const node = await reply("ask me again");
    const launch = await launchAt(6);
    const verdict = callApprove(launch, "AskUserQuestion", { questions: [{ question: "Sure?", options: [{ label: "yes" }] }] });
    await waitForStatus(node, "awaiting_approval");
    const [pending] = await openRequests();
    await command({ type: "answerRequest", boardId, requestId: pending.id, answer: REJECTED_ANSWER });
    expect(await verdict).toMatchObject({ behavior: "deny" });
    answerWith(launch.process, "sess-dismiss", "ok");
    await waitForStatus(node, "done");
  });

  it("marks the node as an error when the CLI reports one", async () => {
    const node = await reply("will fail");
    const launch = await launchAt(7);
    launch.process.emit(initMessage("sess-fail"));
    launch.process.emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in. Run claude and sign in." });
    await waitForStatus(node, "error");
    expect((await view()).parts[node].some((part) => part.type === "error" && part.text.includes("Not logged in"))).toBe(true);
  });

  it("suggests assembling when the parent session has gone", async () => {
    const node = await reply("resume missing", [Object.values((await view()).graph.nodes).find((candidate) => candidate.prompt === "first question")!.id]);
    const launch = await launchAt(8);
    launch.process.finish(1, "No conversation found with session ID: sess-root");
    await waitForStatus(node, "error");
    expect((await view()).parts[node].some((part) => part.type === "error" && part.text.includes("assemble"))).toBe(true);
  });

  it("reports a crash without a result", async () => {
    const node = await reply("crashes");
    const launch = await launchAt(9);
    launch.process.finish(3, "segfault");
    await waitForStatus(node, "error");
    expect((await view()).parts[node].some((part) => part.type === "error" && part.text.includes("code 3") && part.text.includes("segfault"))).toBe(true);
  });

  it("kills the process and keeps partial output when stopped", async () => {
    const node = await reply("long task");
    const launch = await launchAt(10);
    launch.process.emit(initMessage("sess-stop"));
    launch.process.emit(messageStart("m9"));
    launch.process.emit(textDelta(0, "partial"));
    await waitFor(async () => (await textOf(node)) === "partial");
    await command({ type: "abort", boardId, nodeId: node });
    await waitForStatus(node, "done");
    expect(launch.process.wasKilled).toBe(true);
    expect((await nodeOf(node)).stopped).toBe(true);
    expect(await textOf(node)).toBe("partial");
  });

  it("answers a stop that arrives while the CLI waits on an approval", async () => {
    const node = await reply("stop during approval");
    const launch = await launchAt(11);
    const verdict = callApprove(launch, "Write", { file_path: "x.txt" });
    await waitForStatus(node, "awaiting_approval");
    await command({ type: "abort", boardId, nodeId: node });
    expect(await verdict).toMatchObject({ behavior: "deny" });
    await waitForStatus(node, "done");
    expect(await openRequests()).toHaveLength(0);
  });

  it("draws a Task subagent as a satellite node with its own output", async () => {
    const node = await reply("delegate the log check");
    const launch = await launchAt(12);
    expect(launch.args).toContain("--forward-subagent-text");
    launch.process.emit(initMessage("sess-sub"));
    launch.process.emit(toolUse("m7", "task-1", "Task", { description: "Check the logs", subagent_type: "explorer" }));
    launch.process.emit({ ...messageStart("child-1"), parent_tool_use_id: "task-1" });
    launch.process.emit({ ...textDelta(0, "found the error"), parent_tool_use_id: "task-1" });
    launch.process.emit(toolResult("task-1", "the explorer finished"));
    answerWith(launch.process, "sess-sub", "delegated", "m8");
    await waitForStatus(node, "done");
    const current = await view();
    const [satelliteId] = satelliteIdsOf(current.graph, node);
    expect(current.graph.nodes[satelliteId]).toMatchObject({ kind: "subagent", title: "Check the logs", agent: "explorer", status: "done" });
    expect(answerText(current.parts[satelliteId], 1)).toBe("found the error");
    expect(await textOf(node)).toBe("delegated");
  });

  it("shows TodoWrite as a todo list on the node", async () => {
    const node = await reply("plan the work");
    const launch = await launchAt(13);
    launch.process.emit(initMessage("sess-todo"));
    launch.process.emit(toolUse("m9", "todo-1", "TodoWrite", { todos: [{ content: "Design", status: "completed", activeForm: "Designing" }, { content: "Build", status: "in_progress", activeForm: "Building" }] }));
    launch.process.emit(toolUse("m10", "todo-2", "TodoWrite", { todos: [{ content: "Design", status: "completed" }, { content: "Build", status: "completed" }] }));
    answerWith(launch.process, "sess-todo", "planned", "m11");
    await waitForStatus(node, "done");
    const parts = (await view()).parts[node];
    const todos = parts.filter((part) => part.type === "todo");
    expect(todos).toHaveLength(1);
    expect(todos[0].meta?.items).toEqual([
      { content: "Design", status: "completed" },
      { content: "Build", status: "completed" },
    ]);
    expect(parts.some((part) => part.type === "tool")).toBe(false);
  });

  it("serves the approval endpoint only to local processes holding a live secret", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await request("/mcp/not-a-secret", ping)).status).toBe(404);
    expect((await request("/mcp/not-a-secret", ping, { host: HOST, origin: "http://evil.example", "content-type": "application/json" })).status).toBe(403);
    expect((await request("/mcp/not-a-secret", ping, { host: "evil.example:80", "content-type": "application/json" })).status).toBe(403);
    const reading = await server.app.request(`http://${HOST}/mcp/not-a-secret`, { method: "GET", headers: { host: HOST } });
    expect(reading.status).toBe(405);
  });

  it("appends the answer-format guide from a file for the run and removes it afterwards, unless the board turned it off", async () => {
    const guided = launches.length;
    const first = await reply("draw a chart");
    const launch = await launchAt(guided);
    const flag = launch.args.indexOf("--append-system-prompt-file");
    expect(flag).toBeGreaterThan(-1);
    expect(readFileSync(launch.args[flag + 1], "utf8")).toBe(ANSWER_FORMATS_GUIDE);
    answerWith(launch.process, "sess-guide", "done");
    await waitForStatus(first, "done");
    expect(readdirSync(join(directory, "mcp"))).toEqual([]);

    expect((await command({ type: "updateBoard", boardId, answerFormatsGuide: false })).status).toBe(200);
    const plain = await reply("no guide please");
    const plainLaunch = await launchAt(guided + 1);
    expect(plainLaunch.args).not.toContain("--append-system-prompt-file");
    answerWith(plainLaunch.process, "sess-plain", "done");
    await waitForStatus(plain, "done");
    await command({ type: "updateBoard", boardId, answerFormatsGuide: true });
  });

  it("closes identical open approvals when one of them is answered 'always'", async () => {
    const index = launches.length;
    const node = await reply("lint in parallel");
    const launch = await launchAt(index);
    const first = callApprove(launch, "Bash", { command: "npm run duplicate-lint" });
    const second = callApprove(launch, "Bash", { command: "npm run duplicate-lint" });
    await waitFor(async () => (await openRequests()).length === 2);
    const [pending] = await openRequests();
    await command({ type: "answerRequest", boardId, requestId: pending.id, answer: "always" });
    expect((await first).behavior).toBe("allow");
    expect((await second).behavior).toBe("allow");
    expect(await openRequests()).toHaveLength(0);
    answerWith(launch.process, "sess-parallel", "linted");
    await waitForStatus(node, "done");
  });
});

describe("credential guardrail", () => {
  const forbidden = ["CLAUDE_CODE_OAUTH_TOKEN", "setup-token", ".credentials", "keychain", "api.anthropic.com", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  const sources = readdirSync(join(__dirname, "..", "packages", "server", "src", "runtimes"))
    .filter((name) => /^claude.*\.ts$/.test(name) || ["spawnProcess.ts", "executableLocator.ts", "commonEvents.ts"].includes(name))
    .map((name) => join(__dirname, "..", "packages", "server", "src", "runtimes", name))
    .filter((path) => statSync(path).isFile());

  it("scans the claude runtime sources", () => {
    expect(sources.length).toBeGreaterThanOrEqual(5);
  });

  it.each(forbidden)("never mentions %s", (needle) => {
    const offenders = sources.filter((path) => readFileSync(path, "utf8").toLowerCase().includes(needle.toLowerCase()));
    expect(offenders).toEqual([]);
  });
});
