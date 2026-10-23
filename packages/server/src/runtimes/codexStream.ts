import { isAbsolute, relative } from "node:path";
import { answerValueOf, decodeAnswers, isChosen, LINK_DONE_LABEL, NO_LABEL, parseQuestionSpec, patchTextOfFileChanges, YES_LABEL, type FileChange, type QuestionKind, type QuestionSpec, type SessionPlan } from "@branchboard/core";
import type { RunFile } from "../run/types";
import { codexFailureOf } from "./failures";
import { attachmentReferences, isImageFile, numberOf, usageNative, type LooseNative } from "./commonEvents";
import type { RpcMessage } from "./jsonRpcProcess";

export const QUESTION_FEATURE = "features.default_mode_request_user_input";
export const DEFAULT_PERMISSION_MODE = "auto";

export const PERMISSION_MODES = [
  { id: "readOnly", name: "Read only", sandbox: "read-only", approvalPolicy: "on-request" },
  { id: "manual", name: "Manual", sandbox: "workspace-write", approvalPolicy: "untrusted" },
  { id: "auto", name: "Auto", sandbox: "workspace-write", approvalPolicy: "on-request" },
  { id: "dontAsk", name: "Don't ask", sandbox: "workspace-write", approvalPolicy: "never" },
];

const LIMIT_WINDOW_IDS: Record<number, string> = { 300: "five_hour", 10080: "seven_day" };
const MILLISECOND_TIMESTAMP = 1e11;
const MINUTES_PER_HOUR = 60;
const FAILED_STATUSES = ["failed", "declined"];

export interface CodexHandle {
  threadId: string;
  threads: Set<string>;
  workspacePath: string;
  turnId?: string;
}

export interface ThreadChoices {
  workspacePath: string;
  model?: string;
  permissionMode?: string;
  systemNote?: string;
  contextNote?: string;
}

export const permissionModeOf = (id: string | undefined) => PERMISSION_MODES.find((mode) => mode.id === id) ?? PERMISSION_MODES.find((mode) => mode.id === DEFAULT_PERMISSION_MODE)!;

export const threadSettings = (choices: ThreadChoices) => {
  const mode = permissionModeOf(choices.permissionMode);
  const developerInstructions = [choices.systemNote, choices.contextNote].filter(Boolean).join("\n\n");
  return {
    cwd: choices.workspacePath,
    ...(isChosen(choices.model) ? { model: choices.model } : {}),
    sandbox: mode.sandbox,
    approvalPolicy: mode.approvalPolicy,
    approvalsReviewer: "user",
    ...(developerInstructions ? { developerInstructions } : {}),
    config: { [QUESTION_FEATURE]: true },
  };
};

export const threadOpenRequest = (plan: Pick<SessionPlan, "spine">, choices: ThreadChoices): { method: string; params: Record<string, unknown> } => {
  const spine = plan.spine?.runtimeRef;
  if (!spine) return { method: "thread/start", params: threadSettings(choices) };
  return { method: "thread/fork", params: { threadId: spine.sessionId, ...(spine.lastMessageId ? { lastTurnId: spine.lastMessageId } : {}), excludeTurns: true, ...threadSettings(choices) } };
};

export interface SkillRef {
  name: string;
  path: string;
}

export const turnInput = (input: string, files: RunFile[], skills: SkillRef[] = []) => [
  { type: "text", text: `${input}${attachmentReferences(files)}`, text_elements: [] },
  ...files.filter(isImageFile).map((file) => ({ type: "localImage", path: file.path })),
  ...skills.map((skill) => ({ type: "skill", name: skill.name, path: skill.path })),
];

export const turnStartParams = (threadId: string, input: string, files: RunFile[], effort?: string, skills: SkillRef[] = []) => ({ threadId, input: turnInput(input, files, skills), ...(isChosen(effort) ? { effort } : {}) });

const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null;

export const commandTextOf = (source: { command?: string | null; commandActions?: { command?: string }[] | null }): string => {
  const actions = (source.commandActions ?? []).map((action) => action.command).filter((command): command is string => typeof command === "string" && command.length > 0);
  return actions.length > 0 ? actions.join(" && ") : String(source.command ?? "");
};

export const displayPathOf = (workspacePath: string, path: string): string => {
  const inside = relative(workspacePath, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.replaceAll("\\", "/") : path;
};

const fileChangeOf = (workspacePath: string, change: any): FileChange => {
  const kind = change?.kind?.type;
  const movePath = kind === "update" && typeof change.kind.move_path === "string" ? displayPathOf(workspacePath, change.kind.move_path) : undefined;
  return { path: displayPathOf(workspacePath, String(change?.path ?? "")), action: kind === "add" || kind === "delete" ? kind : "update", ...(movePath ? { movePath } : {}), diff: String(change?.diff ?? "") };
};

export const fileChangePaths = (workspacePath: string, changes: unknown): string[] =>
  (Array.isArray(changes) ? changes : []).map((change) => fileChangeOf(workspacePath, change)).map((change) => change.movePath ?? change.path);

interface ToolCall {
  tool: string;
  description: string;
  input: Record<string, unknown>;
}

const toolCallOf = (item: any, workspacePath: string): ToolCall | undefined => {
  switch (item.type) {
    case "commandExecution": {
      const command = commandTextOf(item);
      return { tool: "bash", description: command, input: { command } };
    }
    case "fileChange": {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map((change: unknown) => fileChangeOf(workspacePath, change));
      return { tool: "patch", description: changes.map((change: FileChange) => change.movePath ?? change.path).join(", ") || "patch", input: { patchText: patchTextOfFileChanges(changes) } };
    }
    case "mcpToolCall":
      return { tool: `${item.server}_${item.tool}`, description: String(item.tool), input: isRecord(item.arguments) ? item.arguments : {} };
    case "dynamicToolCall":
      return { tool: String(item.tool), description: String(item.tool), input: isRecord(item.arguments) ? item.arguments : {} };
    case "webSearch":
      return { tool: "websearch", description: String(item.query ?? "web search"), input: { query: item.query } };
    case "imageView":
      return { tool: "read", description: displayPathOf(workspacePath, String(item.path ?? "")), input: { file_path: item.path } };
    case "imageGeneration":
      return { tool: "image", description: String(item.revisedPrompt ?? "image"), input: { prompt: item.revisedPrompt } };
    case "collabAgentToolCall":
      return { tool: item.tool === "spawnAgent" ? "agent" : `agent_${item.tool}`, description: String(item.prompt ?? item.tool), input: { prompt: item.prompt, model: item.model } };
    default:
      return undefined;
  }
};

const contentText = (content: unknown): string =>
  (Array.isArray(content) ? content : []).map((entry: any) => (typeof entry?.text === "string" ? entry.text : "")).filter(Boolean).join("\n");

const toolOutputOf = (item: any): string => {
  if (item.type === "commandExecution") return String(item.aggregatedOutput ?? "");
  if (item.type === "mcpToolCall") return item.error?.message ?? contentText(item.result?.content);
  if (item.type === "dynamicToolCall") return contentText(item.contentItems);
  if (item.type === "imageGeneration") return String(item.savedPath ?? item.failure?.message ?? "");
  return "";
};

const isToolError = (item: any): boolean =>
  FAILED_STATUSES.includes(item.status) || (typeof item.exitCode === "number" && item.exitCode !== 0) || Boolean(item.error) || item.success === false;

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CodexRunState {
  isFinished: boolean;
  rootThreadId: string;
  threads: Set<string>;
  workspacePath: string;
  startedItems: Set<string>;
  streamedItems: Set<string>;
  lastTotals: Map<string, number>;
  usage: UsageTotals;
  contextTokens?: number;
  contextWindow?: number;
  lastError?: unknown;
}

export const createCodexState = (handle: CodexHandle): CodexRunState => ({
  isFinished: false,
  rootThreadId: handle.threadId,
  threads: handle.threads,
  workspacePath: handle.workspacePath,
  startedItems: new Set(),
  streamedItems: new Set(),
  lastTotals: new Map(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const usageOf = (threadId: string, tokenUsage: any, state: CodexRunState): LooseNative[] => {
  const total = numberOf(tokenUsage?.total?.totalTokens);
  if (state.lastTotals.get(threadId) === total) return [];
  state.lastTotals.set(threadId, total);
  const last = tokenUsage?.last ?? {};
  state.usage.input += numberOf(last.inputTokens);
  state.usage.output += numberOf(last.outputTokens);
  state.usage.cacheRead += numberOf(last.cachedInputTokens);
  state.usage.cacheWrite += numberOf(last.cacheWriteInputTokens);
  if (threadId === state.rootThreadId) {
    state.contextTokens = numberOf(last.inputTokens);
    state.contextWindow = typeof tokenUsage?.modelContextWindow === "number" ? tokenUsage.modelContextWindow : state.contextWindow;
  }
  return [usageNative({ inputTokens: state.usage.input, outputTokens: state.usage.output, cacheReadTokens: state.usage.cacheRead, cacheCreationTokens: state.usage.cacheWrite, contextTokens: state.contextTokens, contextWindow: state.contextWindow })];
};

const limitWindowIdOf = (minutes: unknown, fallback: string): string =>
  typeof minutes === "number" && minutes > 0 ? (LIMIT_WINDOW_IDS[minutes] ?? `${Math.round(minutes / MINUTES_PER_HOUR)}h`) : fallback;

const secondsOf = (timestamp: number): number => (timestamp > MILLISECOND_TIMESTAMP ? Math.round(timestamp / 1000) : timestamp);

export const limitsInfoOf = (snapshot: any): Record<string, unknown> | undefined => {
  const windows = [
    ["primary", snapshot?.primary],
    ["secondary", snapshot?.secondary],
  ].filter(([, window]) => typeof window?.usedPercent === "number" && typeof window?.resetsAt === "number");
  if (windows.length === 0) return undefined;
  const unifiedWindows = Object.fromEntries(windows.map(([name, window]) => [limitWindowIdOf(window.windowDurationMins, name), { utilization: window.usedPercent / 100, resetsAt: secondsOf(window.resetsAt) }]));
  return { status: snapshot.rateLimitReachedType ?? "ok", unifiedWindows };
};

const toolStart = (item: any, call: ToolCall, state: CodexRunState): LooseNative[] => {
  if (state.startedItems.has(item.id)) return [];
  state.startedItems.add(item.id);
  return [{ type: "tool-start", partId: `tool:${item.id}`, tool: call.tool, description: call.description, input: call.input }];
};

const spawnedThreads = (item: any, state: CodexRunState): LooseNative[] =>
  (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [])
    .filter((threadId: unknown): threadId is string => typeof threadId === "string" && !state.threads.has(threadId))
    .map((threadId: string): LooseNative => {
      state.threads.add(threadId);
      const prompt = typeof item.prompt === "string" ? item.prompt : undefined;
      return { type: "subagent-start", key: threadId, partId: `tool:${item.id}`, title: prompt?.split("\n")[0]?.slice(0, 60) || "Subagent", agent: item.model || undefined, prompt };
    });

const itemStarted = (item: any, state: CodexRunState): LooseNative[] => {
  const call = toolCallOf(item, state.workspacePath);
  return call ? toolStart(item, call, state) : [];
};

const itemCompleted = (item: any, state: CodexRunState, isRoot: boolean): LooseNative[] => {
  if (item.type === "agentMessage") return state.streamedItems.has(item.id) || !item.text ? [] : [{ type: "text", partId: item.id, delta: String(item.text) }];
  if (item.type === "reasoning") {
    const text = [...(item.summary ?? []), ...(item.summary?.length ? [] : (item.content ?? []))].join("\n\n");
    return state.streamedItems.has(item.id) || !text ? [] : [{ type: "reasoning", partId: `${item.id}:summary:0`, delta: text }];
  }
  if (item.type === "contextCompaction") return isRoot ? [{ type: "compacted" }] : [];
  const call = toolCallOf(item, state.workspacePath);
  if (!call) return [];
  const spawned = item.type === "collabAgentToolCall" && item.tool === "spawnAgent" ? spawnedThreads(item, state) : [];
  return [...toolStart(item, call, state), { type: "tool-done", partId: `tool:${item.id}`, output: toolOutputOf(item), isError: isToolError(item) }, ...spawned];
};

const deltaOf = (kind: "text" | "reasoning", partId: string, itemId: string, delta: unknown, state: CodexRunState): LooseNative[] => {
  state.streamedItems.add(itemId);
  return typeof delta === "string" && delta ? [{ type: kind, partId, delta }] : [];
};

const TODO_STATUSES: Record<string, string> = { pending: "pending", inProgress: "in_progress", completed: "completed" };

const itemEvents = (method: string, params: any, state: CodexRunState, isRoot: boolean): LooseNative[] => {
  switch (method) {
    case "item/agentMessage/delta":
      return deltaOf("text", params.itemId, params.itemId, params.delta, state);
    case "item/reasoning/summaryTextDelta":
      return deltaOf("reasoning", `${params.itemId}:summary:${params.summaryIndex ?? 0}`, params.itemId, params.delta, state);
    case "item/reasoning/textDelta":
      return deltaOf("reasoning", `${params.itemId}:content:${params.contentIndex ?? 0}`, params.itemId, params.delta, state);
    case "item/started":
      return itemStarted(params.item ?? {}, state);
    case "item/completed":
      return itemCompleted(params.item ?? {}, state, isRoot);
    case "turn/plan/updated":
      return [{ type: "todos", items: (params.plan ?? []).map((step: any) => ({ content: step.step, status: TODO_STATUSES[step.status] ?? "pending" })) }];
    case "thread/compacted":
      return isRoot ? [{ type: "compacted" }] : [];
    case "error":
      if (!params.willRetry) state.lastError = params.error;
      return [];
    default:
      return [];
  }
};

const turnEnded = (turn: any, state: CodexRunState): LooseNative[] => {
  state.isFinished = true;
  if (turn?.status !== "failed") return [{ type: "done" }];
  return [{ type: "failure", ...codexFailureOf(turn.error ?? state.lastError) }];
};

export const translateCodexMessage = (message: RpcMessage, state: CodexRunState): LooseNative[] => {
  const params = message.params ?? {};
  if (message.method === "account/rateLimits/updated") {
    const info = limitsInfoOf(params.rateLimits);
    return info ? [{ type: "limits", info }] : [];
  }
  const threadId: string | undefined = params.threadId;
  if (!threadId || !state.threads.has(threadId)) return [];
  const isRoot = threadId === state.rootThreadId;
  if (message.method === "thread/tokenUsage/updated") return usageOf(threadId, params.tokenUsage, state);
  if (message.method === "turn/completed") return isRoot ? turnEnded(params.turn, state) : [{ type: "subagent-done", key: threadId }];
  const events = itemEvents(String(message.method), params, state, isRoot);
  return isRoot ? events : events.map((inner): LooseNative => ({ type: "sub", key: threadId, inner }));
};

export const isRunMessage = (message: RpcMessage, threads: Set<string>): boolean =>
  message.method === "account/rateLimits/updated" || (typeof message.params?.threadId === "string" && threads.has(message.params.threadId));

const BOOLEAN_OPTIONS = [{ label: YES_LABEL }, { label: NO_LABEL }];

export const questionsOfUserInput = (raw: unknown): { ids: string[]; questions: QuestionSpec[] } => {
  const entries = (Array.isArray(raw) ? raw : []).filter(isRecord);
  return {
    ids: entries.map((entry, index) => String(entry.id ?? `q${index}`)),
    questions: entries.map((entry) => parseQuestionSpec({ question: entry.question, header: entry.header, options: entry.options ?? [], isSecret: entry.isSecret })),
  };
};

export const userInputAnswers = (ids: string[], questions: QuestionSpec[], raw: string) => {
  const grid = decodeAnswers(questions.length, raw);
  return { answers: Object.fromEntries(ids.map((id, index) => [id, { answers: (grid[index] ?? []).map((cell) => cell.trim()).filter(Boolean) }])) };
};

const SCHEMA_KINDS: Record<string, QuestionKind> = { number: "number", integer: "integer", boolean: "boolean" };

const optionsOfSchema = (schema: any) => {
  const values: unknown[] = schema.enum ?? schema.items?.enum ?? (schema.oneOf ?? schema.anyOf ?? schema.items?.anyOf ?? []).map((choice: any) => choice.const);
  const titles: unknown[] = schema.enumNames ?? (schema.oneOf ?? schema.anyOf ?? schema.items?.anyOf ?? []).map((choice: any) => choice.title);
  return values.filter((value) => value !== undefined).map((value, index) => ({ label: String(titles[index] ?? value) }));
};

export const questionsOfElicitation = (params: any): { keys: string[]; questions: QuestionSpec[] } => {
  if (params.mode === "url") return { keys: [], questions: [parseQuestionSpec({ question: params.message, kind: "link", url: params.url, options: [{ label: LINK_DONE_LABEL }] })] };
  const schema = params.requestedSchema ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const entries = Object.entries(isRecord(schema.properties) ? schema.properties : {}).filter((entry): entry is [string, Record<string, any>] => isRecord(entry[1]));
  return {
    keys: entries.map(([key]) => key),
    questions: entries.map(([key, field], index) => {
      const kind = SCHEMA_KINDS[field.type];
      return parseQuestionSpec({
        question: field.description ?? field.title ?? key,
        header: index === 0 ? [params.serverName, params.message].filter(Boolean).join(" · ") : field.title,
        options: kind === "boolean" ? BOOLEAN_OPTIONS : optionsOfSchema(field),
        multiple: field.type === "array",
        kind,
        optional: !required.includes(key),
        key,
      });
    }),
  };
};

export const elicitationContent = (keys: string[], questions: QuestionSpec[], raw: string): Record<string, unknown> => {
  const grid = decodeAnswers(questions.length, raw);
  return Object.fromEntries(
    keys.flatMap((key, index) => {
      const value = answerValueOf(questions[index]!, grid[index] ?? []);
      return value === undefined ? [] : [[key, value]];
    }),
  );
};
