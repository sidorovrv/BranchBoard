import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeRollOf, answerText, encodeAnswers, REJECTED_ANSWER, SESSION_GONE_MESSAGE, type RunEvent } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { createLimitsStore } from "../packages/server/src/limits";
import { fakeRuntime } from "../packages/server/src/runtimes/fake";
import { opencodeRuntime } from "../packages/server/src/runtimes/opencodeAuto";
import { createLimiter } from "../packages/server/src/run/limiter";
import { RecoverableError, type RunScope } from "../packages/server/src/run/types";
import { createCodexRuntime, isSupportedCodexVersion, parseCodexVersion } from "../packages/server/src/runtimes/codex";
import { locateCodex } from "../packages/server/src/runtimes/codexLocator";
import {
  createCodexState,
  elicitationContent,
  limitsInfoOf,
  questionsOfElicitation,
  questionsOfUserInput,
  threadOpenRequest,
  translateCodexMessage,
  turnStartParams,
  userInputAnswers,
  type CodexHandle,
} from "../packages/server/src/runtimes/codexStream";
import type { LooseNative } from "../packages/server/src/runtimes/commonEvents";
import { codexFailureOf } from "../packages/server/src/runtimes/failures";
import { fakeCodexPath } from "./e2e/fakeCodex";
import { appClient, ScriptedProcess, waitFor } from "./support";

const FIXTURES = join("tests", "fixtures", "codex", "0.163.0");

const transcript = (name: string): any[] =>
  readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const notificationsOf = (messages: any[]) => messages.filter((message) => message.direction === "in" && message.method && message.id === undefined).map(({ direction, ...message }) => message);

const responseTo = (messages: any[], method: string, index = 0) => {
  const ids = messages.filter((message) => message.direction === "out" && message.method === method).map((message) => message.id);
  return messages.find((message) => message.direction === "in" && message.method === undefined && message.id === ids[index]);
};

const replay = (name: string, threadId?: string, stopAtEnd = true) => {
  const messages = transcript(name);
  const started = responseTo(messages, "thread/start").result.thread;
  const handle: CodexHandle = { threadId: threadId ?? started.id, threads: new Set([threadId ?? started.id]), workspacePath: started.cwd };
  const state = createCodexState(handle);
  const natives: LooseNative[] = [];
  for (const message of notificationsOf(messages)) {
    natives.push(...translateCodexMessage(message, state));
    if (stopAtEnd && state.isFinished) break;
  }
  return { natives, state, messages, workspacePath: started.cwd as string };
};

describe("codex event translation", () => {
  it("turns commands, a patch, reasoning and the answer into tool parts and text", () => {
    const { natives } = replay("tools");
    const types = natives.map((native) => native.type);
    expect(types[0]).toBe("reasoning");
    expect(natives[0]).toEqual({ type: "reasoning", partId: "rs_1:summary:0", delta: "Thinking about it" });
    const starts = natives.filter((native) => native.type === "tool-start");
    expect(starts.map((native) => [native.partId, native.tool])).toEqual([["tool:call_1", "bash"], ["tool:call_2", "bash"], ["tool:call_3", "patch"]]);
    expect(starts[0].input).toEqual({ command: "touch a.txt" });
    expect(starts[1].description).toBe("sh -c 'echo bad >&2; exit 3'");
    expect(starts[2].input.patchText.split("\n")).toEqual([
      "*** Begin Patch",
      "*** Add File: b.txt",
      "+hello",
      "+world",
      "*** Update File: c.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
      "*** Delete File: d.txt",
      "*** Update File: e.txt",
      "*** Move to: f.txt",
      "@@ -1 +1 @@",
      "-e",
      "+E",
      "*** End Patch",
    ]);
    const done = natives.filter((native) => native.type === "tool-done");
    expect(done.map((native) => [native.partId, native.isError])).toEqual([["tool:call_1", true], ["tool:call_2", true], ["tool:call_3", false]]);
    expect(natives.filter((native) => native.type === "text").map((native) => native.delta).join("")).toBe("All done");
    expect(types[types.length - 1]).toBe("done");
  });

  it("counts each model call once and keeps the context window of the last call", () => {
    const { natives } = replay("tools");
    const usage = natives.filter((native) => native.type === "usage").pop();
    expect(usage).toMatchObject({ inputTokens: 101 + 102 + 103 + 104, outputTokens: 28, cacheReadTokens: 160, cacheCreationTokens: 0, contextTokens: 104, contextWindow: 258400 });
  });

  it("measures a fork's usage from its own calls although the fork reports the parent's total", () => {
    const messages = transcript("session");
    const forkId = responseTo(messages, "thread/fork").result.thread.id;
    const { natives } = replay("session", forkId);
    const usage = natives.filter((native) => native.type === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0].inputTokens).toBe(102);
    expect(natives[natives.length - 1].type).toBe("done");
  });

  it("ends an interrupted turn as done", () => {
    const messages = transcript("session");
    const forkId = responseTo(messages, "thread/fork").result.thread.id;
    const state = createCodexState({ threadId: forkId, threads: new Set([forkId]), workspacePath: "/w" });
    const ends = notificationsOf(messages)
      .filter((message) => message.method === "turn/completed" && message.params.threadId === forkId)
      .map((message) => [message.params.turn.status, translateCodexMessage(message, state)]);
    expect(ends).toEqual([
      ["completed", [{ type: "done" }]],
      ["interrupted", [{ type: "done" }]],
    ]);
  });

  it("opens a satellite for a spawned agent and routes its thread there", () => {
    const { natives } = replay("subagent", undefined, false);
    const spawned = natives.find((native) => native.type === "subagent-start");
    expect(spawned).toMatchObject({ prompt: "count files", title: "count files" });
    const childEvents = natives.filter((native) => native.key === spawned!.key);
    expect(childEvents.map((native) => native.type)).toContain("subagent-done");
    expect(natives.filter((native) => native.type === "tool-start")[0]).toMatchObject({ tool: "agent", description: "count files" });
    expect(childEvents.filter((native) => native.type === "sub").map((native) => native.inner.type)).toEqual(["text"]);
    expect(natives.filter((native) => native.type === "done")).toHaveLength(1);
  });

  it("maps plan updates to todos and failed turns to failures", () => {
    const state = createCodexState({ threadId: "t", threads: new Set(["t"]), workspacePath: "/w" });
    expect(translateCodexMessage({ method: "turn/plan/updated", params: { threadId: "t", plan: [{ step: "Read", status: "completed" }, { step: "Write", status: "inProgress" }, { step: "Test", status: "pending" }] } }, state)).toEqual([
      { type: "todos", items: [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress" }, { content: "Test", status: "pending" }] },
    ]);
    translateCodexMessage({ method: "error", params: { threadId: "t", willRetry: false, error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } } }, state);
    expect(translateCodexMessage({ method: "turn/completed", params: { threadId: "t", turn: { status: "failed", error: null } } }, state)).toEqual([{ type: "failure", message: "You've hit your usage limit.", recovery: "usageLimit" }]);
    expect(translateCodexMessage({ method: "item/completed", params: { threadId: "other", item: { type: "agentMessage", id: "m", text: "x" } } }, state)).toEqual([]);
    expect(translateCodexMessage({ method: "thread/compacted", params: { threadId: "t", turnId: "x" } }, state)).toEqual([{ type: "compacted" }]);
  });

  it("names tools of MCP servers, web search and image views", () => {
    const state = createCodexState({ threadId: "t", threads: new Set(["t"]), workspacePath: "/w" });
    const started = (item: object) => translateCodexMessage({ method: "item/started", params: { threadId: "t", item } }, state)[0];
    expect(started({ type: "mcpToolCall", id: "1", server: "docs", tool: "search", arguments: { q: "x" } })).toMatchObject({ tool: "docs_search", input: { q: "x" } });
    expect(started({ type: "webSearch", id: "2", query: "codex" })).toMatchObject({ tool: "websearch", input: { query: "codex" } });
    expect(started({ type: "imageView", id: "3", path: "/w/shot.png" })).toMatchObject({ tool: "read", description: "shot.png" });
    const finished = translateCodexMessage({ method: "item/completed", params: { threadId: "t", item: { type: "mcpToolCall", id: "1", server: "docs", tool: "search", status: "failed", error: { message: "offline" } } } }, state);
    expect(finished).toEqual([{ type: "tool-done", partId: "tool:1", output: "offline", isError: true }]);
  });
});

describe("codex parameters", () => {
  const choices = { workspacePath: "/w", model: "gpt-6.1-sol", permissionMode: "manual", systemNote: "Formats", contextNote: "Earlier turns" };

  it("starts a thread with the sandbox, approvals by the user, the notes and the question feature", () => {
    expect(threadOpenRequest({}, choices)).toEqual({
      method: "thread/start",
      params: { cwd: "/w", model: "gpt-6.1-sol", sandbox: "workspace-write", approvalPolicy: "untrusted", approvalsReviewer: "user", developerInstructions: "Formats\n\nEarlier turns", config: { "features.default_mode_request_user_input": true } },
    });
  });

  it("forks the parent's thread at its turn with the same settings", () => {
    const request = threadOpenRequest({ spine: { nodeId: "n", runtimeRef: { sessionId: "parent", lastMessageId: "turn-1" } } }, { workspacePath: "/w", permissionMode: "readOnly" });
    expect(request.method).toBe("thread/fork");
    expect(request.params).toEqual({ threadId: "parent", lastTurnId: "turn-1", excludeTurns: true, cwd: "/w", sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user", config: { "features.default_mode_request_user_input": true } });
  });

  it("falls back to the auto mode for a permission mode codex does not offer", () => {
    expect(threadOpenRequest({}, { workspacePath: "/w", permissionMode: "bypassPermissions" }).params).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "on-request" });
  });

  it("sends images as local images, other files by path, skills by path and the effort", () => {
    const files = [
      { name: "shot.png", mime: "image/png", path: "/data/a/shot.png" },
      { name: "notes.txt", mime: "text/plain", path: "/data/a/notes.txt" },
    ];
    expect(turnStartParams("t", "Look", files, "high", [{ name: "imagegen", path: "/skills/imagegen/SKILL.md" }])).toEqual({
      threadId: "t",
      effort: "high",
      input: [
        { type: "text", text: "Look\n\nAttached files (read them with your tools):\n- notes.txt: /data/a/notes.txt", text_elements: [] },
        { type: "localImage", path: "/data/a/shot.png" },
        { type: "skill", name: "imagegen", path: "/skills/imagegen/SKILL.md" },
      ],
    });
    expect(turnStartParams("t", "Hi", [], "default")).toEqual({ threadId: "t", input: [{ type: "text", text: "Hi", text_elements: [] }] });
  });
});

describe("codex questions", () => {
  it("answers request_user_input in the shape codex accepted in the probe", () => {
    const messages = transcript("question");
    const asked = messages.find((message) => message.method === "item/tool/requestUserInput");
    const reply = messages.find((message) => message.direction === "out" && message.id === asked.id && message.result);
    const { ids, questions } = questionsOfUserInput(asked.params.questions);
    expect(questions).toEqual([{ question: "Which color?", header: "Color", options: [{ label: "Blue (Recommended)", description: "Calm" }, { label: "Red", description: "Bold" }], multiple: false }]);
    expect(userInputAnswers(ids, questions, encodeAnswers([["Blue"]]))).toEqual(reply.result);
  });

  it("marks secret questions and keeps typed answers", () => {
    const { ids, questions } = questionsOfUserInput([{ id: "token", header: "Token", question: "Paste the token", isOther: true, isSecret: true, options: null }]);
    expect(questions[0].secret).toBe(true);
    expect(userInputAnswers(ids, questions, encodeAnswers([[" abc "]]))).toEqual({ answers: { token: { answers: ["abc"] } } });
  });

  it("turns an MCP form into typed questions and a typed answer", () => {
    const params = {
      mode: "form",
      serverName: "tickets",
      message: "New ticket",
      requestedSchema: {
        type: "object",
        properties: { title: { type: "string", title: "Title" }, priority: { type: "string", enum: ["low", "high"] }, count: { type: "integer" }, urgent: { type: "boolean" } },
        required: ["title"],
      },
    };
    const { keys, questions } = questionsOfElicitation(params);
    expect(keys).toEqual(["title", "priority", "count", "urgent"]);
    expect(questions.map((question) => [question.question, question.kind, question.optional ?? false, question.options.map((option) => option.label)])).toEqual([
      ["Title", undefined, false, []],
      ["priority", undefined, true, ["low", "high"]],
      ["count", "integer", true, []],
      ["urgent", "boolean", true, ["Yes", "No"]],
    ]);
    expect(questions[0].header).toBe("tickets · New ticket");
    expect(elicitationContent(keys, questions, encodeAnswers([["Fix login"], ["high"], ["3"], ["Yes"]]))).toEqual({ title: "Fix login", priority: "high", count: 3, urgent: true });
  });

  it("shows a URL elicitation as a link question", () => {
    expect(questionsOfElicitation({ mode: "url", message: "Sign in to the tracker", url: "https://example.com/auth" }).questions[0]).toMatchObject({ kind: "link", url: "https://example.com/auth", options: [{ label: "Done" }] });
  });
});

describe("codex limits and failures", () => {
  it("names the windows by their length and reads seconds or milliseconds", () => {
    expect(limitsInfoOf({ primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1791054000 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1791540000000 }, rateLimitReachedType: null })).toEqual({
      status: "ok",
      unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1791054000 }, seven_day: { utilization: 0.07, resetsAt: 1791540000 } },
    });
    expect(limitsInfoOf({ primary: { usedPercent: 100, windowDurationMins: 180, resetsAt: 5 }, secondary: null, rateLimitReachedType: "rate_limit_reached" })).toEqual({ status: "rate_limit_reached", unifiedWindows: { "3h": { utilization: 1, resetsAt: 5 } } });
    expect(limitsInfoOf({ primary: null, secondary: null })).toBeUndefined();
  });

  it("maps codex errors to recoveries", () => {
    expect(codexFailureOf({ message: "Limit hit", codexErrorInfo: "rateLimitExceeded" })).toEqual({ message: "Codex usage limit reached: Limit hit", recovery: "usageLimit" });
    expect(codexFailureOf({ message: "Unauthorized", codexErrorInfo: "unauthorized" })).toEqual({ message: "Unauthorized. Run `codex login` in a terminal, then try again.", recovery: "setup" });
    expect(codexFailureOf({ message: "Stream closed", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }).recovery).toBe("setup");
    expect(codexFailureOf({ message: "Too long", codexErrorInfo: "contextWindowExceeded" })).toEqual({ message: "Too long. Summarise the parents in the Context panel and run again." });
    expect(codexFailureOf({ message: "Server error", codexErrorInfo: "internalServerError", additionalDetails: "key sk-abcdefghijklmnopqrstuvwxyz123456" })).toMatchObject({ recovery: "report" });
    expect(codexFailureOf({ message: "Server error", additionalDetails: "key sk-abcdefghijklmnopqrstuvwxyz123456" }).message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(codexFailureOf(undefined)).toEqual({ message: "Codex stopped with an error", recovery: "report" });
  });
});

describe("codex locator and version", () => {
  const environment = (platform: NodeJS.Platform, files: string[], env: NodeJS.ProcessEnv = {}) => ({ platform, env, home: platform === "win32" ? "C:\\Users\\me" : "/home/me", isFile: (path: string) => files.includes(path) });

  it("finds the installer and npm locations", () => {
    const installed = join("/home/me", ".local", "bin", "codex");
    expect(locateCodex(environment("linux", [installed])).path).toBe(installed);
    expect(locateCodex(environment("win32", [join("C:\\Users\\me\\AppData\\Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe")], { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })).path).toContain("codex.exe");
    expect(locateCodex(environment("linux", [], { BRANCHBOARD_CODEX_PATH: "/opt/codex" })).searched).toEqual(["/opt/codex"]);
  });

  it("reads the version and refuses releases before the probed one", () => {
    expect(parseCodexVersion("codex-cli 0.163.0")).toEqual([0, 163, 0]);
    expect(isSupportedCodexVersion([0, 163, 0])).toBe(true);
    expect(isSupportedCodexVersion([0, 170, 2])).toBe(true);
    expect(isSupportedCodexVersion([1, 0, 0])).toBe(true);
    expect(isSupportedCodexVersion([0, 162, 9])).toBe(false);
  });
});

type Handler = (params: any) => unknown;

class FakeAppServer extends ScriptedProcess {
  requests: any[] = [];
  replies: any[] = [];
  handlers: Record<string, Handler> = {
    initialize: () => ({ userAgent: "fake", codexHome: "/home/me/.codex", platformFamily: "unix", platformOs: "linux" }),
    "account/read": () => ({ account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true }),
    "account/rateLimits/read": () => ({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1791054000 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1791540000 }, rateLimitReachedType: null } }),
    "model/list": () => ({
      data: [
        { id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
        { id: "gpt-6.1-mini", displayName: "GPT-6.1-Mini", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
      ],
      nextCursor: null,
    }),
    "skills/list": (params) => ({ data: [{ cwd: params.cwds[0], skills: [{ name: "imagegen", path: "/skills/imagegen/SKILL.md", description: "Make images", enabled: true }], errors: [] }] }),
    "windowsSandbox/readiness": () => ({ status: "ready" }),
    "thread/start": () => ({ thread: { id: "thread-1" } }),
    "thread/fork": () => ({ thread: { id: "thread-2" } }),
    "turn/start": () => ({ turn: { id: "turn-1" } }),
    "turn/interrupt": () => ({}),
    "turn/steer": (params) => ({ turnId: params.expectedTurnId }),
    "thread/delete": () => ({}),
  };

  writeInput(text: string) {
    for (const line of text.split("\n").filter(Boolean)) {
      const message = JSON.parse(line);
      if (message.method === undefined) this.replies.push(message);
      else if (message.id === undefined) continue;
      else {
        this.requests.push(message);
        const handler = this.handlers[message.method];
        queueMicrotask(() => {
          try {
            this.emit({ id: message.id, result: handler ? handler(message.params) : {} });
          } catch (error) {
            this.emit({ id: message.id, error: { code: -32600, message: (error as Error).message } });
          }
        });
      }
    }
  }
  notify(method: string, params: object) {
    this.emit({ method, params });
  }
  requestsOf(method: string) {
    return this.requests.filter((request) => request.method === method);
  }
}

const setup = (overrides: { version?: string; platform?: NodeJS.Platform; missing?: boolean; handlers?: Record<string, Handler> } = {}) => {
  const servers: FakeAppServer[] = [];
  const launches: { executable: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const limits = createLimitsStore().of("codex");
  const runtime = createCodexRuntime({
    limits,
    locate: () => (overrides.missing ? { searched: [] } : { path: "/usr/bin/codex", searched: [] }),
    launch: (executable, args, options) => {
      const server = new FakeAppServer();
      Object.assign(server.handlers, overrides.handlers);
      servers.push(server);
      launches.push({ executable, args, env: options.env });
      return server;
    },
    probeVersion: async () => overrides.version ?? "codex-cli 0.163.0",
    limiter: createLimiter(2),
    platform: overrides.platform ?? "linux",
    environment: () => ({ PATH: "/usr/bin" }),
  });
  return { runtime, servers, launches, limits, server: () => servers[servers.length - 1]! };
};

const makeScope = (overrides: Partial<RunScope> = {}) => {
  const controller = new AbortController();
  const answers = new Map<string, (answer: string) => void>();
  const references: unknown[] = [];
  const scope: RunScope = {
    boardId: "b",
    nodeId: "n",
    workspacePath: "/w",
    files: [],
    signal: controller.signal,
    setRuntimeRef: (reference) => void references.push(reference),
    waitForAnswer: (requestId) => new Promise((resolve) => answers.set(requestId, resolve)),
    ...overrides,
  };
  return { scope, controller, answers, references };
};

const collect = async (runtime: ReturnType<typeof createCodexRuntime>, iterable: AsyncIterable<LooseNative>, scope: RunScope) => {
  const events: RunEvent[] = [];
  for await (const native of iterable) events.push(...(runtime.eventMap[native.type]?.(native, scope) ?? []));
  return events;
};

describe("codex runtime catalog", () => {
  it("lists models with efforts, skills, permission modes and limits for a signed-in codex", async () => {
    const { runtime, launches, limits } = setup();
    const catalog = await runtime.catalog("/w");
    expect(catalog.health).toEqual({ ok: true, detail: "found codex 0.163.0, signed in with ChatGPT (plus)" });
    expect(catalog.models.map((model) => [model.id, model.efforts])).toEqual([["default", undefined], ["gpt-6.1-sol", ["default", "low", "high"]], ["gpt-6.1-mini", ["default", "low"]]]);
    expect(catalog.skills).toEqual([{ id: "imagegen", name: "imagegen", description: "Make images" }]);
    expect(catalog.permissionModes?.map((mode) => mode.id)).toEqual(["readOnly", "manual", "auto", "dontAsk"]);
    expect(catalog).toMatchObject({ defaultPermissionMode: "auto", meters: ["limits"], canCompact: true, controls: ["followUp"], agents: ["default"] });
    expect(limits.current()?.windows.map((window) => [window.id, window.utilization])).toEqual([["five_hour", 0.2], ["seven_day", 0.05]]);
    expect(launches).toEqual([{ executable: "/usr/bin/codex", args: ["app-server"], env: { PATH: "/usr/bin" } }]);
  });

  it("initializes once without experimental capabilities", async () => {
    const { runtime, server } = setup();
    await runtime.catalog("/w");
    await runtime.catalog("/w");
    expect(server().requestsOf("initialize")).toEqual([{ id: 1, method: "initialize", params: { clientInfo: { name: "branchboard", title: "Branchboard", version: expect.any(String) }, capabilities: { experimentalApi: false, requestAttestation: false } } }]);
  });

  it("asks for codex login when codex needs a sign-in and accepts an API key sign-in", async () => {
    const signedOut = setup({ handlers: { "account/read": () => ({ account: null, requiresOpenaiAuth: true }) } });
    expect((await signedOut.runtime.catalog("/w")).health).toEqual({ ok: false, detail: "Run `codex login` in a terminal, then Check again." });
    const apiKey = setup({ handlers: { "account/read": () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: true }) } });
    expect((await apiKey.runtime.catalog("/w")).health.detail).toBe("found codex 0.163.0, signed in with an API key");
    expect(await apiKey.runtime.diagnostics!("/w")).toEqual({ executable: "/usr/bin/codex", authMethod: "apiKey", isSignedIn: true });
  });

  it("reports a missing or outdated codex and a Windows sandbox that is not set up", async () => {
    expect((await setup({ missing: true }).runtime.catalog("/w")).health.detail).toContain("npm install -g @openai/codex");
    expect((await setup({ version: "codex-cli 0.150.1" }).runtime.catalog("/w")).health.detail).toContain("needs codex 0.163.0 or newer");
    const windows = setup({ platform: "win32", handlers: { "windowsSandbox/readiness": () => ({ status: "notConfigured" }) } });
    expect((await windows.runtime.catalog("C:\\w")).health).toEqual({ ok: false, detail: "Run `codex` once in a terminal to set up its sandbox, then Check again." });
  });

  it("restarts the app-server after Check again", async () => {
    const { runtime, servers } = setup();
    await runtime.catalog("/w");
    await runtime.forgetCaches?.();
    expect(servers[0]!.wasKilled).toBe(true);
    await runtime.catalog("/w");
    expect(servers).toHaveLength(2);
  });
});

describe("codex runtime sessions and runs", () => {
  it("streams a turn and records the thread and turn as the runtime reference", async () => {
    const { runtime, server } = setup();
    const { scope, references } = makeScope({ model: "gpt-6.1-sol", effort: "high", permissionMode: "auto", systemNote: "Note" });
    const handle = await runtime.openSession({ missingTurns: [] }, scope);
    expect(server().requestsOf("thread/start")[0].params).toMatchObject({ cwd: "/w", model: "gpt-6.1-sol", sandbox: "workspace-write", approvalPolicy: "on-request", developerInstructions: "Note" });
    const run = collect(runtime, runtime.execute(handle, "Hello", scope), scope);
    await waitFor(() => server().requestsOf("turn/start").length === 1);
    expect(server().requestsOf("turn/start")[0].params).toEqual({ threadId: "thread-1", input: [{ type: "text", text: "Hello", text_elements: [] }], effort: "high" });
    server().notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    server().notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "Hi " });
    server().notify("item/agentMessage/delta", { threadId: "other", turnId: "x", itemId: "m9", delta: "not mine" });
    server().notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "there" });
    server().notify("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "Hi there" } });
    server().notify("thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 2 }, last: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 2 }, modelContextWindow: 1000 } });
    server().notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    const events = await run;
    expect(events.filter((event) => event.type === "part.delta").map((event) => (event as any).text).join("")).toBe("Hi there");
    expect(events.find((event) => event.type === "usage")).toEqual({ type: "usage", usage: expect.objectContaining({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, contextTokens: 10, contextWindow: 1000 }) });
    expect(events[events.length - 1]).toEqual({ type: "done" });
    expect(references).toEqual([{ sessionId: "thread-1", lastMessageId: "turn-1" }]);
  });

  it("forks the parent's thread and asks to resend the context when it is gone", async () => {
    const { runtime, server } = setup();
    const { scope } = makeScope();
    const spine = { nodeId: "p", runtimeRef: { sessionId: "thread-0", lastMessageId: "turn-0" } };
    expect((await runtime.openSession({ spine, missingTurns: [] }, scope)).threadId).toBe("thread-2");
    expect(server().requestsOf("thread/fork")[0].params).toMatchObject({ threadId: "thread-0", lastTurnId: "turn-0", excludeTurns: true });
    server().handlers["thread/fork"] = () => {
      throw new Error("no rollout found for thread id thread-0");
    };
    const failure = await runtime.openSession({ spine, missingTurns: [] }, scope).catch((error) => error);
    expect(failure).toBeInstanceOf(RecoverableError);
    expect(failure).toMatchObject({ message: SESSION_GONE_MESSAGE, recovery: "assemble" });
  });

  it("asks for command approvals on the board and answers once, always and reject", async () => {
    const { runtime, server } = setup();
    const { scope, answers } = makeScope();
    const handle = await runtime.openSession({ missingTurns: [] }, scope);
    const events: RunEvent[] = [];
    const run = (async () => {
      for await (const native of runtime.execute(handle, "Go", scope)) events.push(...(runtime.eventMap[native.type]?.(native, scope) ?? []));
    })();
    await waitFor(() => server().requestsOf("turn/start").length === 1);
    const approval = (id: number, command: string, availableDecisions?: unknown[]) =>
      server().emit({ id, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: `c${id}`, command: `/bin/bash -lc '${command}'`, commandActions: [{ type: "unknown", command }], ...(availableDecisions ? { availableDecisions } : {}) } });
    const opened = () => events.filter((event) => event.type === "request.opened").map((event) => (event as any).request);
    approval(0, "npm test");
    await waitFor(() => opened().length === 1);
    expect(opened()[0]).toMatchObject({ kind: "approval", title: "Allow command?", detail: "npm test", options: ["once", "always", "reject"] });
    answers.get(opened()[0].id)!("once");
    await waitFor(() => server().replies.length === 1);
    approval(1, "npm test", ["accept", { acceptWithExecpolicyAmendment: {} }, "cancel"]);
    await waitFor(() => opened().length === 2);
    answers.get(opened()[1].id)!("always");
    await waitFor(() => server().replies.length === 2);
    approval(2, "npm test");
    await waitFor(() => server().replies.length === 3);
    approval(3, "rm -rf build");
    await waitFor(() => opened().length === 3);
    answers.get(opened()[2].id)!(REJECTED_ANSWER);
    await waitFor(() => server().replies.length === 4);
    expect(server().replies).toEqual([
      { id: 0, result: { decision: "accept" } },
      { id: 1, result: { decision: "accept" } },
      { id: 2, result: { decision: "acceptForSession" } },
      { id: 3, result: { decision: "decline" } },
    ]);
    server().notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    await run;
  });

  it("names the files of a file change approval and answers questions", async () => {
    const { runtime, server } = setup();
    const { scope, answers } = makeScope();
    const handle = await runtime.openSession({ missingTurns: [] }, scope);
    const events: RunEvent[] = [];
    const run = (async () => {
      for await (const native of runtime.execute(handle, "Go", scope)) events.push(...(runtime.eventMap[native.type]?.(native, scope) ?? []));
    })();
    await waitFor(() => server().requestsOf("turn/start").length === 1);
    server().notify("item/started", { threadId: "thread-1", turnId: "turn-1", item: { type: "fileChange", id: "p1", status: "inProgress", changes: [{ path: "/w/src/a.ts", kind: { type: "update", move_path: null }, diff: "@@\n-a\n+b\n" }] } });
    server().emit({ id: 7, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "p1" } });
    const opened = () => events.filter((event) => event.type === "request.opened").map((event) => (event as any).request);
    await waitFor(() => opened().length === 1);
    expect(opened()[0]).toMatchObject({ title: "Allow file changes?", detail: "src/a.ts" });
    answers.get(opened()[0].id)!("once");
    server().emit({ id: 8, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", itemId: "q", questions: [{ id: "color", header: "Color", question: "Which color?", isOther: true, isSecret: false, options: [{ label: "Blue", description: "Calm" }] }] } });
    await waitFor(() => opened().length === 2);
    expect(opened()[1]).toMatchObject({ kind: "question", questions: [{ question: "Which color?", header: "Color" }] });
    answers.get(opened()[1].id)!(encodeAnswers([["Teal"]]));
    server().emit({ id: 9, method: "account/chatgptAuthTokens/refresh", params: { threadId: "thread-1" } });
    await waitFor(() => server().replies.length === 3);
    expect([...server().replies].sort((left, right) => left.id - right.id)).toEqual([
      { id: 7, result: { decision: "accept" } },
      { id: 8, result: { answers: { color: { answers: ["Teal"] } } } },
      { id: 9, error: { code: -32603, message: "account/chatgptAuthTokens/refresh is not supported by Branchboard" } },
    ]);
    server().notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    await run;
  });

  it("cancels pending requests and interrupts the turn on Stop", async () => {
    const { runtime, server } = setup();
    const { scope, controller } = makeScope();
    const handle = await runtime.openSession({ missingTurns: [] }, scope);
    const run = collect(runtime, runtime.execute(handle, "Go", scope), scope);
    await waitFor(() => server().requestsOf("turn/start").length === 1);
    server().emit({ id: 4, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "c", command: "make", availableDecisions: ["accept", "cancel"] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await run;
    await waitFor(() => server().replies.length === 1 && server().requestsOf("turn/interrupt").length === 1);
    expect(server().replies).toEqual([{ id: 4, result: { decision: "cancel" } }]);
    expect(server().requestsOf("turn/interrupt")[0].params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
  });

  it("sends follow-ups as steering input to the running turn", async () => {
    const { runtime, server } = setup();
    const { scope } = makeScope();
    const handle = await runtime.openSession({ missingTurns: [] }, scope);
    const run = collect(runtime, runtime.execute(handle, "Go", scope), scope);
    await waitFor(() => server().requestsOf("turn/start").length === 1);
    await waitFor(() => handle.turnId === "turn-1");
    await runtime.control!(handle, { type: "followUp", text: "Also add tests" });
    expect(server().requestsOf("turn/steer")[0].params).toEqual({ threadId: "thread-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "Also add tests", text_elements: [] }] });
    server().notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    await run;
  });

  it("fails the run with the exit and starts a new app-server next time", async () => {
    const { runtime, servers, server } = setup();
    const { scope } = makeScope();
    const handle = await runtime.openSession({ missingTurns: [] }, scope);
    const run = collect(runtime, runtime.execute(handle, "Go", scope), scope).catch((error) => error);
    await waitFor(() => server().requestsOf("turn/start").length === 1);
    server().finish(101, "panic: out of memory");
    const failure = await run;
    expect(failure).toBeInstanceOf(RecoverableError);
    expect(failure).toMatchObject({ message: "The codex command exited with code 101 before finishing: panic: out of memory", recovery: "report" });
    await waitFor(() => servers.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.openSession({ missingTurns: [] }, scope);
    expect(servers).toHaveLength(2);
  });

  it("deletes threads and keeps going when one is gone or still forked", async () => {
    const { runtime, server } = setup();
    await runtime.dropSession!({ sessionId: "thread-1" }, "/w");
    server().handlers["thread/delete"] = (params) => {
      throw new Error(params.threadId === "gone" ? "no rollout found for thread id gone" : "cannot delete thread parent: forked history still references it");
    };
    await runtime.dropSession!({ sessionId: "gone" }, "/w");
    await runtime.dropSession!({ sessionId: "parent" }, "/w");
    expect(server().requestsOf("thread/delete").map((request) => request.params.threadId)).toEqual(["thread-1", "gone", "parent"]);
  });

  it("writes titles in an ephemeral read-only thread with the light model", async () => {
    const { runtime, server } = setup();
    expect(await runtime.titleModel!(makeScope().scope)).toBe("gpt-6.1-mini");
    const { scope } = makeScope({ model: "gpt-6.1-mini" });
    const title = runtime.generateText!("Plan the trip", "title", scope, new AbortController().signal);
    await waitFor(() => server().requestsOf("turn/start").length === 1);
    expect(server().requestsOf("thread/start")[0].params).toMatchObject({ ephemeral: true, sandbox: "read-only", approvalPolicy: "never", model: "gpt-6.1-mini", developerInstructions: expect.stringContaining("short titles") });
    server().notify("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "m", text: " Trip plan " } });
    server().notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    expect(await title).toBe("Trip plan");
  });
});

describe("codex runs through the board", () => {
  const PORT = 47125;
  const SLOW_START_MS = 15000;
  const directory = mkdtempSync(join(tmpdir(), "branchboard-codex-"));
  const codexLimits = createLimitsStore().of("codex");
  const codex = createCodexRuntime({ locate: () => ({ path: fakeCodexPath(), searched: [] }), limits: codexLimits });
  const server = createApp({ databasePath: join(directory, "test.db"), security: { port: PORT, extraOrigins: [] }, webRoot: join(directory, "none"), runtimes: { fake: fakeRuntime, opencode: opencodeRuntime, claude: fakeRuntime, codex } });
  const client = appClient(() => server, PORT);
  let boardId = "";

  const command = async (body: Record<string, unknown>) => (await client.command(body)).json;
  const view = () => client.view(boardId);
  const waitForStatus = (nodeId: string, status: string) => client.waitForStatus(boardId, nodeId, status, SLOW_START_MS);

  beforeAll(async () => {
    boardId = (await command({ type: "createBoard", title: "Codex", workspacePath: directory, mode: "codex" })).id;
  });

  afterAll(async () => {
    await codex.forgetCaches?.();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("asks for a command on the board, finishes the answer and keeps the thread for children", async () => {
    const root = (await command({ type: "reply", boardId, prompt: "approve the test run" })).nodeId as string;
    await waitFor(async () => (await client.openRequests(boardId)).length > 0, SLOW_START_MS);
    const [opened] = await client.openRequests(boardId);
    expect(opened).toMatchObject({ kind: "approval", title: "Allow command?", detail: "npm test" });
    await command({ type: "answerRequest", boardId, requestId: opened.id, answer: "once" });
    await waitForStatus(root, "done");
    const finished = await view();
    expect(answerText(finished.parts[root], activeRollOf(finished.graph.nodes[root]))).toBe("Ran npm test");
    expect(finished.graph.nodes[root].runtimeRef).toEqual({ sessionId: expect.stringMatching(/^thread-\d+$/), lastMessageId: expect.stringMatching(/^turn-\d+$/) });
    expect(finished.graph.nodes[root].usage).toMatchObject({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 10, contextWindow: 200000 });
    expect(codexLimits.current()?.windows.map((window) => [window.id, window.utilization])).toEqual([["five_hour", 0.2], ["seven_day", 0.05]]);
    const child = (await command({ type: "reply", boardId, prompt: "and then?", parentIds: [root] })).nodeId as string;
    await waitForStatus(child, "done");
    const after = await view();
    expect(answerText(after.parts[child], activeRollOf(after.graph.nodes[child]))).toBe("Echo: and then?");
    expect(after.graph.nodes[child].contextMode).toBe("exact");
  });
});

describe("codex guardrails", () => {
  const sources = readdirSync(join("packages", "server", "src", "runtimes"))
    .filter((name) => name.startsWith("codex"))
    .map((name) => readFileSync(join("packages", "server", "src", "runtimes", name), "utf8"));
  const forbidden = ["auth.json", "CODEX_HOME", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "chatgptAuthTokens", "account/login", "account/logout", "gatewayOAuth", "danger-full-access", "dangerously-bypass", "experimentalApi: true", "auto_review", "guardian_subagent"];

  it("reads no credentials, offers no sign-in and never sends the full-access sandbox", () => {
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const needle of forbidden) expect(sources.filter((source) => source.includes(needle)).length, needle).toBe(0);
  });
});
