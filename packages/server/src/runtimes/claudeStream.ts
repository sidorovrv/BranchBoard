import { dirname } from "node:path";
import { isChosen, UNSET_CHOICE } from "@branchboard/core";
import type { RunFile } from "../run/types";
import { attachmentReferences, isImageFile, type LooseNative } from "./commonEvents";

export const APPROVAL_SERVER_NAME = "branchboard";
export const APPROVAL_TOOL_NAME = "approve";
export const PERMISSION_PROMPT_TOOL = `mcp__${APPROVAL_SERVER_NAME}__${APPROVAL_TOOL_NAME}`;
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
export const DEFAULT_CHOICE = UNSET_CHOICE;

const SAFE_ARGUMENT = /^[\w.:\-@/[\]]+$/;
const PATH_KEYS = ["file_path", "path", "notebook_path", "url", "pattern", "query"];
const MAX_DETAIL_CHARS = 300;
const REFUSED_PERMISSION_MODES = ["bypassPermissions"];

export interface ClaudeArguments {
  sessionId: string;
  resumeFrom?: string;
  model?: string;
  agent?: string;
  effort?: string;
  permissionMode?: string;
  mcpConfigPath: string;
  systemNotePath?: string;
  addDirectories: string[];
  forwardSubagentText?: boolean;
}

const checkedArgument = (label: string, value: string): string => {
  if (!SAFE_ARGUMENT.test(value)) throw new Error(`Refusing to pass an unsafe ${label} to the claude command: "${value}"`);
  return value;
};

const checkedPermissionMode = (mode: string): string => {
  if (REFUSED_PERMISSION_MODES.includes(mode)) throw new Error(`The ${mode} permission mode is not available from Branchboard`);
  return checkedArgument("permission mode", mode);
};

export const buildClaudeArguments = (input: ClaudeArguments): string[] => [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  ...(input.forwardSubagentText ? ["--forward-subagent-text"] : []),
  ...(input.resumeFrom ? ["--resume", checkedArgument("session id", input.resumeFrom), "--fork-session"] : []),
  "--session-id",
  checkedArgument("session id", input.sessionId),
  ...(isChosen(input.model) ? ["--model", checkedArgument("model", input.model)] : []),
  ...(isChosen(input.agent) ? ["--agent", checkedArgument("agent", input.agent)] : []),
  ...(isChosen(input.effort) ? ["--effort", checkedArgument("effort", input.effort)] : []),
  ...(isChosen(input.permissionMode) ? ["--permission-mode", checkedPermissionMode(input.permissionMode)] : []),
  "--mcp-config",
  input.mcpConfigPath,
  "--permission-prompt-tool",
  PERMISSION_PROMPT_TOOL,
  ...(input.systemNotePath ? ["--append-system-prompt-file", input.systemNotePath] : []),
  ...input.addDirectories.flatMap((directory) => ["--add-dir", directory]),
];

export const buildMcpConfig = (approvalUrl: string) => ({ mcpServers: { [APPROVAL_SERVER_NAME]: { type: "http", url: approvalUrl } } });

export const attachmentDirectories = (files: RunFile[]): string[] => [...new Set(files.filter((file) => !isImageFile(file)).map((file) => dirname(file.path)))];

export const buildUserMessage = (input: string, files: RunFile[], readBase64: (path: string) => string): string => {
  const images = files.filter(isImageFile).map((file) => ({ type: "image", source: { type: "base64", media_type: file.mime, data: readBase64(file.path) } }));
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `${input}${attachmentReferences(files)}` }, ...images] } })}\n`;
};

export const displayToolName = (toolName: string): string => toolName.replace(/^mcp__(.+?)__(.+)$/, "$1_$2");

const firstText = (input: Record<string, any> | undefined, keys: string[]): string | undefined =>
  keys.map((key) => input?.[key]).find((value): value is string => typeof value === "string" && value.length > 0);

export const describeToolCall = (toolName: string, input: Record<string, any> | undefined): string =>
  firstText(input, ["description"]) ?? firstText(input, ["command", ...PATH_KEYS]) ?? displayToolName(toolName);

export const approvalDetail = (toolName: string, input: Record<string, any> | undefined): string => {
  const specific = toolName === "Bash" ? firstText(input, ["command"]) : firstText(input, PATH_KEYS);
  if (specific !== undefined) return specific;
  const serialized = JSON.stringify(input ?? {});
  return serialized.length > MAX_DETAIL_CHARS ? `${serialized.slice(0, MAX_DETAIL_CHARS)}…` : serialized;
};

export const MIN_SUBAGENT_TEXT_VERSION = [2, 1, 211];

export const supportsSubagentText = (versionOutput: string): boolean => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (!match) return false;
  const found = match.slice(1, 4).map(Number);
  for (let index = 0; index < MIN_SUBAGENT_TEXT_VERSION.length; index++) {
    if (found[index] !== MIN_SUBAGENT_TEXT_VERSION[index]) return found[index] > MIN_SUBAGENT_TEXT_VERSION[index];
  }
  return true;
};

const SUBAGENT_TOOLS = ["Task", "Agent"];
const TODO_TOOL = "TodoWrite";

export interface StreamState {
  messageId?: string;
  model?: string;
  contextTokens?: number;
  firstCallCache?: { read: number; creation: number };
  streamedMessages: Set<string>;
  startedTools: Set<string>;
  subagentKeys: Set<string>;
  backgroundKeys: Set<string>;
  hasBackground: boolean;
  pendingBackground: number;
  isFollowUpOwed: boolean;
  isBetweenTurns: boolean;
  results: any[];
  children: Map<string, StreamState>;
  isFinished: boolean;
}

export const createStreamState = (): StreamState => ({
  streamedMessages: new Set(),
  startedTools: new Set(),
  subagentKeys: new Set(),
  backgroundKeys: new Set(),
  hasBackground: false,
  pendingBackground: 0,
  isFollowUpOwed: false,
  isBetweenTurns: false,
  results: [],
  children: new Map(),
  isFinished: false,
});

export const FOLLOW_UP_GRACE_MS = 20_000;

export const QUEUED_TURN_GRACE_MS = 3_000;

export const backgroundGraceOf = (state: StreamState): number | undefined => {
  if (!state.isBetweenTurns || state.isFinished || state.pendingBackground > 0) return undefined;
  return state.isFollowUpOwed ? FOLLOW_UP_GRACE_MS : QUEUED_TURN_GRACE_MS;
};

export const parseStreamLine = (line: string): any | undefined => {
  try {
    return line.trim() ? JSON.parse(line) : undefined;
  } catch {
    return undefined;
  }
};

const toolOutputText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).filter(Boolean).join("\n");
};

const TIMED_OUT = Symbol("timed out");

export async function* linesUntilFollowUpEnds(lines: AsyncIterable<string>, state: StreamState, graceOf = backgroundGraceOf): AsyncGenerator<string> {
  const iterator = lines[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = iterator.next();
      const graceMs = graceOf(state);
      const grace = graceMs === undefined ? undefined : new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), graceMs)));
      const item = await (grace ? Promise.race([next, grace]) : next).finally(() => clearTimeout(timer));
      if (item === TIMED_OUT || item.done) return;
      yield item.value;
    }
  } finally {
    void iterator.return?.();
  }
}

const translateStreamEvent =(event: any, state: StreamState): LooseNative[] => {
  if (event?.type === "message_start") {
    state.messageId = event.message?.id;
    return [];
  }
  if (event?.type !== "content_block_delta" || !state.messageId) return [];
  state.streamedMessages.add(state.messageId);
  const partId = `${state.messageId}:${event.index}`;
  if (event.delta?.type === "text_delta") return [{ type: "text", partId, delta: event.delta.text }];
  if (event.delta?.type === "thinking_delta") return [{ type: "reasoning", partId, delta: event.delta.thinking }];
  return [];
};

const promptTokensOf = (usage: any): number => (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);

const translateAssistant = (message: any, state: StreamState): LooseNative[] => {
  const messageId: string = message.id ?? "";
  if (message.usage) {
    state.contextTokens = promptTokensOf(message.usage);
    state.firstCallCache ??= { read: message.usage.cache_read_input_tokens ?? 0, creation: message.usage.cache_creation_input_tokens ?? 0 };
  }
  const blocks: any[] = Array.isArray(message.content) ? message.content : [];
  return blocks.flatMap((block, index): LooseNative[] => {
    const partId = `${messageId}:${index}`;
    if (block.type === "tool_use" && !state.startedTools.has(block.id)) {
      state.startedTools.add(block.id);
      if (block.name === TODO_TOOL) return [{ type: "todos", items: block.input?.todos }];
      const toolStart: LooseNative = { type: "tool-start", partId: `tool:${block.id}`, tool: displayToolName(block.name), description: describeToolCall(block.name, block.input), input: block.input };
      if (!SUBAGENT_TOOLS.includes(block.name)) return [toolStart];
      state.subagentKeys.add(block.id);
      const title = block.input?.description ?? block.input?.subagent_type ?? "Subagent";
      return [toolStart, { type: "subagent-start", key: block.id, partId: toolStart.partId, title: String(title), agent: block.input?.subagent_type, prompt: typeof block.input?.prompt === "string" ? block.input.prompt : undefined }];
    }
    if (state.streamedMessages.has(messageId)) return [];
    if (block.type === "text" && block.text) return [{ type: "text", partId, delta: block.text }];
    if (block.type === "thinking" && block.thinking) return [{ type: "reasoning", partId, delta: block.thinking }];
    return [];
  });
};

const translateToolResults = (message: any, state: StreamState): LooseNative[] => {
  const blocks: any[] = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((block) => block.type === "tool_result")
    .flatMap((block): LooseNative[] => {
      const done: LooseNative = { type: "tool-done", partId: `tool:${block.tool_use_id}`, output: toolOutputText(block.content), isError: Boolean(block.is_error) };
      const isOpenSubagent = state.subagentKeys.has(block.tool_use_id) && !state.backgroundKeys.has(block.tool_use_id);
      return isOpenSubagent ? [done, { type: "subagent-done", key: block.tool_use_id }] : [done];
    });
};

const childStateOf = (state: StreamState, key: string): StreamState => {
  const existing = state.children.get(key);
  if (existing) return existing;
  const created = createStreamState();
  state.children.set(key, created);
  return created;
};

const translateSubagentMessage = (message: any, state: StreamState): LooseNative[] => {
  const key: string = message.parent_tool_use_id;
  const child = childStateOf(state, key);
  const inner =
    message.type === "stream_event"
      ? translateStreamEvent(message.event, child)
      : message.type === "assistant"
        ? translateAssistant(message.message ?? {}, child)
        : message.type === "user"
          ? translateToolResults(message.message ?? {}, child)
          : [];
  return inner.map((item): LooseNative => ({ type: "sub", key, inner: item }));
};

const failureText = (result: any): string => {
  if (typeof result.result === "string" && result.result) return result.result;
  if (Array.isArray(result.errors) && result.errors.length > 0) return result.errors.join("\n");
  return `Claude stopped with ${result.subtype ?? "an error"}`;
};

const contextWindowOf = (result: any, state: StreamState): number | undefined => {
  const perModel: Record<string, any> = result.modelUsage ?? {};
  return (perModel[state.model ?? ""] ?? Object.values(perModel)[0])?.contextWindow;
};

const sumOf = (results: any[], read: (usage: any) => number | undefined): number => results.reduce((total, result) => total + (read(result.usage ?? {}) ?? 0), 0);

export const finalEvents = (state: StreamState): LooseNative[] => {
  state.isFinished = true;
  const result = state.results.at(-1);
  if (!result) return [];
  const usageEvents: LooseNative[] = result.usage
    ? [
        {
          type: "usage",
          inputTokens: sumOf(state.results, promptTokensOf),
          outputTokens: sumOf(state.results, (usage) => usage.output_tokens),
          contextTokens: state.contextTokens,
          contextWindow: contextWindowOf(result, state),
          cacheReadTokens: sumOf(state.results, (usage) => usage.cache_read_input_tokens),
          cacheCreationTokens: sumOf(state.results, (usage) => usage.cache_creation_input_tokens),
          costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
          firstCallCacheReadTokens: state.firstCallCache?.read,
          firstCallCacheCreationTokens: state.firstCallCache?.creation,
        },
      ]
    : [];
  const hasFailed = Boolean(result.is_error) || (result.subtype !== undefined && result.subtype !== "success");
  return [...usageEvents, hasFailed ? { type: "failure", message: failureText(result) } : { type: "done" }];
};

const translateResult = (result: any, state: StreamState): LooseNative[] => {
  state.isBetweenTurns = true;
  if (state.hasBackground && result.num_turns === 0) return [];
  state.results.push(result);
  return state.hasBackground ? [] : finalEvents(state);
};

const translateSystem = (message: any, state: StreamState): LooseNative[] => {
  if (message.subtype === "init" && message.session_id) {
    state.model = message.model;
    state.isFollowUpOwed = false;
    state.isBetweenTurns = false;
    return [{ type: "session", sessionId: message.session_id }];
  }
  if (message.subtype === "background_tasks_changed") {
    state.pendingBackground = Array.isArray(message.tasks) ? message.tasks.length : 0;
    state.hasBackground ||= state.pendingBackground > 0;
    return [];
  }
  if (message.subtype === "task_started" && message.is_backgrounded && typeof message.tool_use_id === "string") state.backgroundKeys.add(message.tool_use_id);
  if (message.subtype !== "task_notification") return [];
  state.isFollowUpOwed = true;
  const key = message.tool_use_id;
  if (!state.backgroundKeys.delete(key)) return [];
  return [{ type: "subagent-done", key }];
};

export const translateClaudeMessage = (message: any, state: StreamState): LooseNative[] => {
  if (!message) return [];
  if (message.parent_tool_use_id) return translateSubagentMessage(message, state);
  if (message.type === "rate_limit_event") return [{ type: "limits", info: message.rate_limit_info }];
  if (message.type === "system") return translateSystem(message, state);
  if (message.type === "stream_event") return translateStreamEvent(message.event, state);
  if (message.type === "assistant") return translateAssistant(message.message ?? {}, state);
  if (message.type === "user") return translateToolResults(message.message ?? {}, state);
  if (message.type === "result") return translateResult(message, state);
  return [];
};
