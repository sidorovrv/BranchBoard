import { dirname } from "node:path";
import { isChosen, UNSET_CHOICE } from "@branchboard/core";
import type { RunFile } from "../run/types";
import type { LooseNative } from "./commonEvents";

export const APPROVAL_SERVER_NAME = "branchboard";
export const APPROVAL_TOOL_NAME = "approve";
export const PERMISSION_PROMPT_TOOL = `mcp__${APPROVAL_SERVER_NAME}__${APPROVAL_TOOL_NAME}`;
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
export const DEFAULT_CHOICE = UNSET_CHOICE;

const SAFE_ARGUMENT = /^[\w.:\-@/[\]]+$/;
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
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

const isImage = (file: RunFile): boolean => IMAGE_MIMES.includes(file.mime);

export const attachmentDirectories = (files: RunFile[]): string[] => [...new Set(files.filter((file) => !isImage(file)).map((file) => dirname(file.path)))];

export const buildUserMessage = (input: string, files: RunFile[], readBase64: (path: string) => string): string => {
  const referenced = files.filter((file) => !isImage(file));
  const references = referenced.length > 0 ? `\n\nAttached files (read them with your tools):\n${referenced.map((file) => `- ${file.name}: ${file.path}`).join("\n")}` : "";
  const images = files.filter(isImage).map((file) => ({ type: "image", source: { type: "base64", media_type: file.mime, data: readBase64(file.path) } }));
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `${input}${references}` }, ...images] } })}\n`;
};

export const displayToolName = (toolName: string): string => toolName.replace(/^mcp__(.+?)__(.+)$/, "$1_$2");

const firstText = (input: Record<string, any> | undefined, keys: string[]): string | undefined =>
  keys.map((key) => input?.[key]).find((value): value is string => typeof value === "string" && value.length > 0);

export const describeToolCall = (toolName: string, input: Record<string, any> | undefined): string =>
  firstText(input, ["description"]) ?? firstText(input, ["command", ...PATH_KEYS]) ?? displayToolName(toolName);

export const approvalDetail = (toolName: string, input: Record<string, any> | undefined): string => {
  const specific = toolName === "Bash" ? firstText(input, ["command"]) : firstText(input, PATH_KEYS);
  return (specific ?? JSON.stringify(input ?? {})).slice(0, MAX_DETAIL_CHARS);
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
  children: Map<string, StreamState>;
  isFinished: boolean;
}

export const createStreamState = (): StreamState => ({ streamedMessages: new Set(), startedTools: new Set(), subagentKeys: new Set(), children: new Map(), isFinished: false });

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

const translateStreamEvent = (event: any, state: StreamState): LooseNative[] => {
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
      return [toolStart, { type: "subagent-start", key: block.id, title: String(title), agent: block.input?.subagent_type, prompt: typeof block.input?.prompt === "string" ? block.input.prompt : undefined }];
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
      return state.subagentKeys.has(block.tool_use_id) ? [done, { type: "subagent-done", key: block.tool_use_id }] : [done];
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

const translateResult = (result: any, state: StreamState): LooseNative[] => {
  state.isFinished = true;
  const usage = result.usage ?? {};
  const usageEvents: LooseNative[] = result.usage
    ? [
        {
          type: "usage",
          inputTokens: promptTokensOf(usage),
          outputTokens: usage.output_tokens ?? 0,
          contextTokens: state.contextTokens,
          contextWindow: contextWindowOf(result, state),
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
          firstCallCacheReadTokens: state.firstCallCache?.read,
          firstCallCacheCreationTokens: state.firstCallCache?.creation,
        },
      ]
    : [];
  const hasFailed = Boolean(result.is_error) || (result.subtype !== undefined && result.subtype !== "success");
  return [...usageEvents, hasFailed ? { type: "failure", message: failureText(result) } : { type: "done" }];
};

export const translateClaudeMessage = (message: any, state: StreamState): LooseNative[] => {
  if (!message) return [];
  if (message.parent_tool_use_id) return translateSubagentMessage(message, state);
  if (message.type === "rate_limit_event") return [{ type: "limits", info: message.rate_limit_info }];
  if (message.type === "system" && message.subtype === "init" && message.session_id) {
    state.model = message.model;
    return [{ type: "session", sessionId: message.session_id }];
  }
  if (message.type === "stream_event") return translateStreamEvent(message.event, state);
  if (message.type === "assistant") return translateAssistant(message.message ?? {}, state);
  if (message.type === "user") return translateToolResults(message.message ?? {}, state);
  if (message.type === "result") return translateResult(message, state);
  return [];
};
