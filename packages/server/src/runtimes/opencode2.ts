import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ancestorFolders, readCommandSources } from "../commandFiles";
import { activeQuestionFlags, answerValueOf, decodeAnswers, DEFAULT_PERMISSION_PRESET, isChosen, LINK_DONE_LABEL, NO_LABEL, PERMISSION_MODES, presetRules, parseQuestionSpec, REJECTED_ANSWER, SESSION_GONE_MESSAGE, UNSET_CHOICE, YES_LABEL, type Catalog, type CatalogCommand, type CatalogModel, type CredentialStatus, type PendingRequest, type QuestionKind, type QuestionSpec } from "@branchboard/core";
import { log } from "../log";
import { usageNative } from "./commonEvents";
import { CUT_OFF_NOTE, failureOf, STEPS_LIMIT_MESSAGE, STEPS_LIMIT_NOTE, STREAM_ENDED_EARLY } from "./failures";
import { opencodeEventMap } from "./opencode";
import { locateOpencodeGeneration2 } from "./opencodeGeneration";
import { ONE_SHOT_SYSTEM_PROMPTS } from "../run/askOnce";
import { unsentFileNotes } from "../run/fileChecks";
import { loadPanels, panelSpecsOf, runPanelAction } from "./opencodePanels";
import { configuredServerAddress, createServerPool, isNotFound, opencodeSlots, serverSentEvents, splitModel, type OpencodeServer, type ServerPool } from "./opencodeServer";
import { pickSmallModel } from "./smallModel";
import { RecoverableError, type NativeEvent, type RunScope, type RuntimeSteps } from "../run/types";

interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

interface Opencode2Handle {
  server: OpencodeServer;
  directory: string;
  sessionId: string;
  agent?: string;
  model?: ModelRef;
  contextWindow?: number;
  isFork?: boolean;
}

type Opencode2Native = NativeEvent & Record<string, any>;

interface SessionUsage {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Seen2 {
  rootId: string;
  childIds: Set<string>;
  toolNames: Map<string, string>;
  textLengths: Map<string, number>;
  usage: Map<string, SessionUsage>;
  lastAssistantMessage?: string;
  failedMessage?: string;
  contextTokens?: number;
  contextWindow?: number;
  isShellRun?: boolean;
  secrets: () => string[];
}

const LIST_LOAD_ATTEMPTS = 10;
const LIST_LOAD_DELAY_MS = 500;
const SYSTEM_NOTE_KEY = "branchboard";
const CONTEXT_NOTE_KEY = "branchboard-context";
const LIST_CACHE_MS = 10 * 60 * 1000;
const SERVER_WARMUP_MS = 15000;

const userInstallPool = createServerPool({
  logName: "opencode2",
  label: "OpenCode 2",
  healthPath: "/api/info",
  isShared: true,
  remote: configuredServerAddress,
  secrets: () => [configuredServerAddress()?.password ?? ""].filter(Boolean),
  locate: locateOpencodeGeneration2,
  missingMessage: "The opencode2 command was not found. Install OpenCode 2 (npm install -g @opencode/cli) or set BRANCHBOARD_OPENCODE2_PATH to its full path.",
});

const call = (server: OpencodeServer, directory: string, path: string, init?: RequestInit) => server.pool.call(server, directory, path, init);
const callJson = (server: OpencodeServer, directory: string, path: string, init?: RequestInit) => server.pool.callJson(server, directory, path, init);
const post = (server: OpencodeServer, directory: string, path: string, body?: unknown) => server.pool.post(server, directory, path, body);

const noSecrets = (): string[] => [];

export const createSeen2 = (rootId: string, contextWindow?: number, secrets: () => string[] = noSecrets): Seen2 => ({ rootId, childIds: new Set(), toolNames: new Map(), textLengths: new Map(), usage: new Map(), contextWindow, secrets });

const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const textOfContent = (content: unknown): string =>
  (Array.isArray(content) ? content : []).map((entry: any) => (typeof entry?.text === "string" ? entry.text : "")).filter(Boolean).join("\n");

const totalUsageOf = (seen: Seen2): Opencode2Native => {
  const sessions = [...seen.usage.values()];
  const sum = (pick: (usage: SessionUsage) => number) => sessions.reduce((total, usage) => total + pick(usage), 0);
  return usageNative({ inputTokens: sum((usage) => usage.input + usage.cacheRead + usage.cacheWrite), outputTokens: sum((usage) => usage.output), cacheReadTokens: sum((usage) => usage.cacheRead), cacheCreationTokens: sum((usage) => usage.cacheWrite), costUsd: sum((usage) => usage.cost), contextTokens: seen.contextTokens, contextWindow: seen.contextWindow });
};

const FIELD_KINDS: Record<string, QuestionKind> = { number: "number", integer: "integer", boolean: "boolean", external: "link" };
const BOOLEAN_OPTIONS = [{ label: YES_LABEL }, { label: NO_LABEL }];

const questionOfField = (form: any, field: any): QuestionSpec => {
  const isQuestionForm = form.metadata?.kind === "question";
  const kind = FIELD_KINDS[field.type];
  const options = kind === "boolean" ? BOOLEAN_OPTIONS : kind === "link" ? [{ label: LINK_DONE_LABEL }] : (field.options ?? []).map((option: any) => ({ label: option.label ?? option.value, description: option.description }));
  return parseQuestionSpec({
    question: field.description ?? field.title ?? field.key,
    header: isQuestionForm ? field.title : [form.title, field.title].filter(Boolean).join(" · "),
    options,
    multiple: field.type === "multiselect" || field.type === "array",
    kind,
    optional: !isQuestionForm && field.required !== true,
    url: field.url,
    key: field.key,
    when: field.when,
  });
};

const questionOfForm = (form: any): Opencode2Native[] => {
  const fields: any[] = (Array.isArray(form?.fields) ? form.fields : []).filter((field: any) => field.hidden !== true);
  if (!form?.id || fields.length === 0) return [];
  const keys = fields.map((field, index) => String(field.key ?? `q${index}`));
  return [{ type: "question", remoteId: `${form.sessionID}/${form.id}/${keys.join(",")}`, questions: fields.map((field) => questionOfField(form, field)) }];
};

const forgetPartsOf = (seen: Seen2, messageId: string): string[] => {
  const keys = [...seen.textLengths.keys()].filter((key) => key.startsWith(`${messageId}:`));
  keys.forEach((key) => seen.textLengths.delete(key));
  seen.failedMessage = undefined;
  return keys;
};

const textPart = (kind: "text" | "reasoning", data: any, seen: Seen2, replacement?: string): Opencode2Native[] => {
  const partId = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
  const emitted = seen.textLengths.get(partId) ?? 0;
  const delta = replacement === undefined ? String(data.delta ?? "") : replacement.slice(emitted);
  if (!delta) return [];
  seen.textLengths.set(partId, emitted + delta.length);
  return [{ type: kind, partId, delta }];
};

const translateSession = (raw: Opencode2Native, sessionId: string, seen: Seen2): Opencode2Native[] => {
  const data = raw.data ?? {};
  const isRoot = sessionId === seen.rootId;
  if (isRoot && data.assistantMessageID) seen.lastAssistantMessage = data.assistantMessageID;
  switch (raw.type) {
    case "session.inbox.enqueued":
      return !isRoot && data.item?.payload?.text ? [{ type: "user-prompt", text: String(data.item.payload.text) }] : [];
    case "session.text.delta":
      return textPart("text", data, seen);
    case "session.text.ended":
      return textPart("text", data, seen, String(data.text ?? ""));
    case "session.reasoning.delta":
      return textPart("reasoning", data, seen);
    case "session.reasoning.ended":
      return textPart("reasoning", data, seen, String(data.text ?? ""));
    case "session.tool.input.started":
      seen.toolNames.set(data.id, String(data.name ?? "tool"));
      return [];
    case "session.tool.called": {
      const tool = seen.toolNames.get(data.id) ?? "tool";
      const started: Opencode2Native = { type: "tool-start", partId: data.id, tool, description: data.input?.description ?? tool, input: data.input };
      return tool === "todowrite" ? [started, { type: "todos", items: data.input?.todos }] : [started];
    }
    case "session.tool.success":
      return [{ type: "tool-done", partId: data.id, output: textOfContent(data.content), isError: false }];
    case "session.tool.failed": {
      const message = String(data.error?.message ?? data.error?.type ?? "Tool failed");
      const done: Opencode2Native = { type: "tool-done", partId: data.id, output: message, isError: true };
      const isStepsLimit = isRoot && message.includes(STEPS_LIMIT_MESSAGE) && data.assistantMessageID;
      return isStepsLimit ? [done, ...textPart("text", { assistantMessageID: data.assistantMessageID, ordinal: "steps" }, seen, STEPS_LIMIT_NOTE)] : [done];
    }
    case "permission.asked":
      return [{ type: "permission", remoteId: `${sessionId}/${data.id}`, title: data.message ?? data.action ?? "Permission requested", detail: Array.isArray(data.resources) ? data.resources.join(", ") || undefined : undefined }];
    case "form.created":
      return questionOfForm(data.form);
    case "session.retry.scheduled":
      return [{ type: "retry", attempt: numberOf(data.attempt), at: numberOf(data.at), reason: failureOf({ type: data.error?.type, status: data.error?.status, message: data.error?.message }, seen.secrets()).message }];
    case "session.step.failed":
      seen.failedMessage = data.assistantMessageID ?? seen.lastAssistantMessage;
      return [];
    case "session.synthetic":
      return seen.failedMessage ? [{ type: "retry-restart", partKeys: forgetPartsOf(seen, seen.failedMessage) }] : [];
    case "session.step.ended":
      if (isRoot && data.tokens) seen.contextTokens = numberOf(data.tokens.input) + numberOf(data.tokens.cache?.read) + numberOf(data.tokens.cache?.write);
      return data.finish === "length" && data.assistantMessageID ? [{ type: "text", partId: `${data.assistantMessageID}:text:cutoff`, delta: CUT_OFF_NOTE }] : [];
    case "session.compaction.ended":
    case "session.compaction.completed":
    case "session.compaction.succeeded":
      return isRoot ? [{ type: "compacted" }] : [];
    case "session.compaction.failed":
      return isRoot ? [{ type: "compaction-failed", message: String(data.error?.message ?? "Compaction failed") }] : [];
    case "session.shell.started":
      return seen.isShellRun ? [{ type: "tool-start", partId: data.shell.id, tool: "shell", description: String(data.shell.command), input: { command: data.shell.command } }] : [];
    case "session.shell.ended":
      return seen.isShellRun ? [{ type: "tool-done", partId: data.shell.id, output: String(data.output?.output ?? ""), isError: typeof data.shell.exit === "number" && data.shell.exit !== 0 }, { type: "idle" }] : [];
    case "session.execution.failed":
      return [{ type: "failure", ...failureOf({ type: data.error?.type, status: data.error?.status, message: data.error?.message ?? data.error?.type ?? "OpenCode 2 session failed", body: data.error?.response?.body }, seen.secrets()) }];
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      return [{ type: "idle" }];
    default:
      return [];
  }
};

export const translateEvent2 = (raw: Opencode2Native, seen: Seen2): Opencode2Native[] => {
  const data = raw.data ?? {};
  if (raw.type === "session.created" && data.parentID === seen.rootId) {
    seen.childIds.add(data.sessionID);
    return [{ type: "subagent-start", key: data.sessionID, title: String(data.title ?? "Subagent"), agent: data.agent }];
  }
  const sessionId: string | undefined = data.sessionID ?? data.form?.sessionID;
  if (!sessionId || (sessionId !== seen.rootId && !seen.childIds.has(sessionId))) return [];
  if (raw.type === "session.usage.updated") {
    const tokens = data.tokens ?? {};
    seen.usage.set(sessionId, { cost: numberOf(data.cost), input: numberOf(tokens.input), output: numberOf(tokens.output) + numberOf(tokens.reasoning), cacheRead: numberOf(tokens.cache?.read), cacheWrite: numberOf(tokens.cache?.write) });
    return [totalUsageOf(seen)];
  }
  const events = translateSession(raw, sessionId, seen);
  if (sessionId === seen.rootId) return events;
  return events.map((inner): Opencode2Native => (inner.type === "idle" ? { type: "subagent-done", key: sessionId } : { type: "sub", key: sessionId, inner }));
};

const modelRefOf = (model: string | undefined, effort: string | undefined): ModelRef | undefined => {
  const parts = isChosen(model) ? splitModel(model) : undefined;
  return parts && { id: parts.modelID, providerID: parts.providerID, ...(isChosen(effort) ? { variant: effort } : {}) };
};

const permissionRulesOf = (scope: RunScope) => presetRules(isChosen(scope.permissionMode) ? scope.permissionMode : DEFAULT_PERMISSION_PRESET);

const sameModel =(current: ModelRef | undefined, wanted: ModelRef): boolean =>
  current?.id === wanted.id && current.providerID === wanted.providerID && (current.variant ?? "default") === (wanted.variant ?? "default");

const sessionPath = (handle: Opencode2Handle, suffix = "") => `/api/session/${handle.sessionId}${suffix}`;

const applyRunChoices = async (handle: Opencode2Handle, scope: RunScope) => {
  const { server, directory } = handle;
  const model = modelRefOf(scope.model, scope.effort);
  if (model && !sameModel(handle.model, model)) await post(server, directory, sessionPath(handle, "/model"), { model });
  if (isChosen(scope.agent) && scope.agent !== handle.agent) await post(server, directory, sessionPath(handle, "/agent"), { agent: scope.agent });
  if (scope.environment || handle.isFork) await call(server, directory, sessionPath(handle, "/environment"), { method: "PUT", body: JSON.stringify({ variables: scope.environment ?? {} }) });
  await setInstructionEntry(handle, SYSTEM_NOTE_KEY, scope.systemNote);
  await setInstructionEntry(handle, CONTEXT_NOTE_KEY, scope.contextNote);
};

const setInstructionEntry = async ({ server, directory, sessionId }: Opencode2Handle, key: string, value: string | undefined) => {
  const path = `/api/experimental/session/${sessionId}/instructions/entries/${key}`;
  if (value) await call(server, directory, path, { method: "PUT", body: JSON.stringify({ value }) });
  else await call(server, directory, path, { method: "DELETE" }).catch(() => undefined);
};

const SLASH_PATTERN = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

const commandNamesOf = async (handle: Opencode2Handle): Promise<Set<string>> => new Set((await listCommands(handle.server, handle.directory)).map((command) => command.name));

const promptFieldsOf = (scope: RunScope) => ({
  files: scope.files.map((file) => ({ uri: pathToFileURL(file.path).href, name: file.name })),
  agents: (scope.subagents ?? []).map((name) => ({ name })),
  skills: (scope.skills ?? []).map((id) => ({ id })),
});

const SHELL_PREFIX = "!";

export const isShellInput = (input: string): boolean => input.startsWith(SHELL_PREFIX) && input.slice(SHELL_PREFIX.length).trim().length > 0;

const sendInput = async (handle: Opencode2Handle, input: string, scope: RunScope) => {
  const { server, directory } = handle;
  if (isShellInput(input)) {
    await post(server, directory, sessionPath(handle, "/shell"), { command: input.slice(SHELL_PREFIX.length).trim() });
    return;
  }
  const fields = promptFieldsOf(scope);
  const slash = SLASH_PATTERN.exec(input.trim());
  if (slash && (await commandNamesOf(handle)).has(slash[1])) {
    await post(server, directory, sessionPath(handle, "/command"), { name: slash[1], text: slash[2] ?? "", ...fields });
    return;
  }
  await post(server, directory, sessionPath(handle, "/prompt"), { text: input, ...fields });
};

const UNSENT_FILES_PART = "files:unsent";

const acceptedMediaOf = async ({ server, directory, model }: Opencode2Handle, scope: RunScope): Promise<string[] | undefined> => {
  const wanted = modelRefOf(scope.model, undefined) ?? model;
  const fallback = wanted ? undefined : await callJson(server, directory, "/api/model/default").then((reply) => reply.data, () => undefined);
  const providerID = wanted?.providerID ?? fallback?.providerID;
  const modelID = wanted?.id ?? fallback?.modelID;
  const models = await loadModels(server, directory).catch(() => []);
  return models.find((candidate) => candidate.providerID === providerID && candidate.modelID === modelID)?.capabilities?.input;
};

const MAX_STREAM_RESUMES = 3;
const STREAM_RESUME_DELAY_MS = 1000;

const writtenPartsOf = (assistant: any, seen: Seen2): Opencode2Native[] => {
  const counts: Record<string, number> = {};
  return (assistant.content ?? []).flatMap((entry: any) => {
    if (entry?.type !== "text" && entry?.type !== "reasoning") return [];
    const ordinal = counts[entry.type] ?? 0;
    counts[entry.type] = ordinal + 1;
    return textPart(entry.type, { assistantMessageID: assistant.id, ordinal }, seen, String(entry.text ?? ""));
  });
};

const settledEvents = async (handle: Opencode2Handle, seen: Seen2): Promise<Opencode2Native[] | undefined> => {
  const { server, directory, sessionId } = handle;
  const active = (await callJson(server, directory, "/api/session/active")).data ?? {};
  if (active[sessionId]) return undefined;
  const entries: any[] = (await callJson(server, directory, sessionPath(handle, "/context"))).data ?? [];
  const runEntries = entries.slice(entries.findLastIndex((entry) => entry.type === "user") + 1);
  const texts = runEntries.filter((entry) => entry.type === "assistant").flatMap((assistant) => writtenPartsOf(assistant, seen));
  const outcome = [...entries].reverse().find((entry) => entry.type === "idle")?.outcome;
  const ending: Opencode2Native = outcome === "succeeded" || outcome === "interrupted" ? { type: "idle" } : { type: "failure", ...failureOf({ isEarlyEnd: true }, seen.secrets()) };
  return [...texts, ending];
};

async function* execute(handle: Opencode2Handle, input: string, scope: RunScope): AsyncGenerator<Opencode2Native> {
  const { server, directory, sessionId } = handle;
  let stream = await call(server, directory, "/api/event", { signal: scope.signal });
  const seen = createSeen2(sessionId, handle.contextWindow, server.pool.secrets);
  seen.isShellRun = isShellInput(input);
  scope.signal.addEventListener("abort", () => void post(server, directory, sessionPath(handle, "/interrupt")).catch(() => undefined), { once: true });
  await applyRunChoices(handle, scope);
  const unsent = scope.files.length > 0 ? unsentFileNotes(scope.files, await acceptedMediaOf(handle, scope)) : [];
  if (unsent.length > 0) yield { type: "text", partId: UNSENT_FILES_PART, delta: unsent.map((note) => `${note}\n\n`).join("") };
  await sendInput(handle, input, scope);
  const isEnding = (native: Opencode2Native) => native.type === "idle" || native.type === "failure";
  try {
    for (let resumes = 0; ; resumes++) {
      try {
        for await (const raw of serverSentEvents<Opencode2Native>(stream, scope.signal)) {
          for (const native of translateEvent2(raw, seen)) {
            yield native;
            if (isEnding(native)) return;
          }
        }
      } catch (error) {
        if (scope.signal.aborted) throw error;
        log.warn("opencode2", `Event stream for session ${sessionId} broke`, error);
      }
      if (scope.signal.aborted) return;
      if (resumes >= MAX_STREAM_RESUMES) {
        yield { type: "failure", ...failureOf({ isEarlyEnd: true }, seen.secrets()) };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, STREAM_RESUME_DELAY_MS));
      const settled = await settledEvents(handle, seen).catch(() => undefined);
      if (settled) {
        yield* settled;
        return;
      }
      stream = await call(server, directory, "/api/event", { signal: scope.signal });
    }
  } finally {
    scope.setRuntimeRef({ sessionId, lastMessageId: seen.lastAssistantMessage });
  }
}

const loadList = async (server: OpencodeServer, directory: string, path: string, keep: (entry: any) => boolean = () => true): Promise<any[]> => {
  for (let attempt = 1; ; attempt++) {
    const kept = ((await callJson(server, directory, path)).data ?? []).filter(keep);
    const isWarmingUp = Date.now() - server.startedAt < SERVER_WARMUP_MS;
    if (kept.length > 0 || !isWarmingUp || attempt >= LIST_LOAD_ATTEMPTS) return kept;
    await new Promise((resolve) => setTimeout(resolve, LIST_LOAD_DELAY_MS));
  }
};

const listCache = new Map<string, { at: number; list: Promise<any[]> }>();

const knownLocations = new Map<OpencodeServer, Set<string>>();

const reloadLocations = async (servers: ServerPool["servers"]) => {
  const running = (await Promise.all([...servers.values()].map((started) => started.catch(() => undefined)))).filter((server): server is OpencodeServer => server !== undefined);
  await Promise.all(running.flatMap((server) => [...(knownLocations.get(server) ?? [])].map((directory) => post(server, directory, "/api/location/reload").catch((error) => log.warn("opencode2", `Could not reload ${directory}`, error)))));
};

const cachedList = (server: OpencodeServer, directory: string, path: string, keep?: (entry: any) => boolean): Promise<any[]> => {
  knownLocations.set(server, (knownLocations.get(server) ?? new Set()).add(directory));
  const key = `${server.baseUrl}|${directory}|${path}`;
  const cached = listCache.get(key);
  if (cached && Date.now() - cached.at < LIST_CACHE_MS) return cached.list;
  const list = loadList(server, directory, path, keep);
  listCache.set(key, { at: Date.now(), list });
  list.catch(() => listCache.delete(key));
  return list;
};

const loadModels = (server: OpencodeServer, directory: string) => cachedList(server, directory, "/api/model", (model) => model.enabled);

const configSourcesOf = async (server: OpencodeServer, directory: string): Promise<{ folders: string[]; documents: unknown[] }> => {
  const entries: any[] = await callJson(server, directory, "/api/config").catch(() => []);
  return {
    folders: entries.filter((entry) => entry?.type === "directory" && typeof entry.path === "string").map((entry) => join(entry.path, "commands")),
    documents: entries.filter((entry) => entry?.type === "document").map((entry) => entry.info),
  };
};

const listCommands = async (server: OpencodeServer, directory: string): Promise<CatalogCommand[]> => {
  const [listed, sources] = await Promise.all([cachedList(server, directory, "/api/command").catch(() => []), configSourcesOf(server, directory)]);
  const described = readCommandSources({ folders: [...sources.folders, ...ancestorFolders(directory, join(".opencode", "commands")).reverse()], separator: "/", config: sources.documents });
  return listed.map((entry) => {
    const detail = described.find((command) => command.name === entry.name);
    return { ...detail, name: String(entry.name), description: entry.description ?? detail?.description, template: detail?.template ?? "", passThrough: true };
  });
};

const catalogModelOf = (model: any): CatalogModel => {
  const variants = (model.variants ?? []).map((variant: any) => String(variant.id));
  return { id: `${model.providerID}/${model.modelID}`, name: model.name ?? model.modelID, provider: model.providerID, contextWindow: model.limit?.context, efforts: variants.length > 0 ? [UNSET_CHOICE, ...variants] : undefined };
};

export interface Opencode2Config {
  id: "opencode2" | "anthropic" | "openai";
  pool: ServerPool;
  providerIds?: string[];
  fallbackModels?: CatalogModel[];
  credential?: () => CredentialStatus;
  executable?: () => string | undefined;
}

const modelsOf = async (config: Opencode2Config, server: OpencodeServer, directory: string): Promise<any[]> => {
  const models = await loadModels(server, directory);
  return config.providerIds ? models.filter((model) => config.providerIds!.includes(model.providerID)) : models;
};

const catalogOf = async (config: Opencode2Config, workspacePath: string): Promise<Catalog> => {
  try {
    const server = await config.pool.serverFor(workspacePath);
    const [allAgents, models, commands, skills, defaultModel, defaultAgent] = await Promise.all([
      cachedList(server, workspacePath, "/api/agent", (agent) => !agent.hidden),
      modelsOf(config, server, workspacePath),
      listCommands(server, workspacePath),
      cachedList(server, workspacePath, "/api/skill").catch(() => []),
      callJson(server, workspacePath, "/api/model/default").then((reply) => reply.data, () => undefined),
      configSourcesOf(server, workspacePath).then((sources) => sources.documents.map((document: any) => document?.default_agent).filter(Boolean).pop(), () => undefined),
    ]);
    return {
      agents: allAgents.filter((agent) => agent.mode !== "subagent").map((agent) => String(agent.id)),
      subagents: allAgents.filter((agent) => agent.mode === "subagent" || agent.mode === "all").map((agent) => String(agent.id)),
      skills: skills.map((skill) => ({ id: String(skill.id), name: String(skill.name ?? skill.id), description: skill.description })),
      models: models.length === 0 && config.fallbackModels ? config.fallbackModels : models.map(catalogModelOf),
      credential: config.credential?.(),
      defaultModel: config.providerIds ? undefined : defaultModel?.providerID && defaultModel.modelID ? `${defaultModel.providerID}/${defaultModel.modelID}` : undefined,
      defaultAgent: typeof defaultAgent === "string" ? defaultAgent : undefined,
      permissionModes: PERMISSION_MODES,
      defaultPermissionMode: DEFAULT_PERMISSION_PRESET,
      commands,
      meters: ["cost"],
      canCompact: true,
      controls: ["followUp", "background"],
      shellPrompts: true,
      health: { ok: true, detail: "connected to opencode2 serve" },
    };
  } catch (error) {
    log.error(config.id, `Catalog failed for ${workspacePath}`, error);
    return { agents: [], models: config.fallbackModels ?? [], credential: config.credential?.(), health: { ok: false, detail: error instanceof Error ? error.message : String(error) } };
  }
};

const providersOf = (models: any[]) =>
  [...new Set<string>(models.map((model) => model.providerID))].map((id) => ({
    id,
    models: Object.fromEntries(models.filter((model) => model.providerID === id).map((model) => [model.modelID, { id: model.modelID, status: model.status, cost: model.cost?.[0], limit: model.limit }])),
  }));

const answerQuestion = async (server: OpencodeServer, directory: string, request: PendingRequest, answer: string) => {
  const [sessionId, formId, keyList = ""] = String(request.remoteId).split("/");
  const keys = keyList.split(",");
  const path = `/api/session/${sessionId}/form/${formId}`;
  if (answer === REJECTED_ANSWER) {
    await call(server, directory, path, { method: "DELETE" });
    return;
  }
  const questions = request.questions ?? [];
  const grid = decodeAnswers(questions.length, answer);
  const active = activeQuestionFlags(questions, grid);
  const reply = Object.fromEntries(questions.flatMap((question, index) => {
    const value = active[index] ? answerValueOf(question, grid[index] ?? []) : undefined;
    return value === undefined ? [] : [[keys[index] || `q${index}`, value]];
  }));
  await post(server, directory, `${path}/reply`, { answer: reply });
};

const answerPermission = async (server: OpencodeServer, directory: string, remoteId: string, answer: string, message?: string) => {
  const [sessionId, permissionId] = remoteId.split("/");
  await post(server, directory, `/api/session/${sessionId}/permission/${permissionId}/reply`, { decision: answer, ...(message ? { message } : {}) }).catch((error) => {
    if (!isNotFound(error)) throw error;
    log.info("opencode2", `Permission ${permissionId} was already settled by opencode`);
  });
};

export const createOpencode2Runtime = (config: Opencode2Config, { serverFor, servers } = config.pool): RuntimeSteps<Opencode2Native, Opencode2Handle> => ({
  id: config.id,
  editsFiles: true,
  canSuggestTitles: true,
  slots: opencodeSlots,
  forgetCaches: async () => {
    listCache.clear();
    await reloadLocations(servers);
  },
  generateText: async (input, purpose, scope) => {
    const server = await serverFor(scope.workspacePath);
    const reply = await callJson(server, scope.workspacePath, "/api/experimental/generate", { method: "POST", body: JSON.stringify({ prompt: `${ONE_SHOT_SYSTEM_PROMPTS[purpose]}\n\n${input}`, model: modelRefOf(scope.model, undefined) }), signal: scope.signal });
    return String(reply.data?.text ?? "");
  },
  testConnection: async () => {
    const scopeDirectory = process.cwd();
    try {
      const server = await serverFor(scopeDirectory);
      const models = await modelsOf(config, server, scopeDirectory);
      const model = models[0] && { id: models[0].modelID, providerID: models[0].providerID };
      await callJson(server, scopeDirectory, "/api/experimental/generate", { method: "POST", body: JSON.stringify({ prompt: "Reply with one word.", model }) });
      return { ok: true, detail: `Connected. ${models.length} models available.` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
  dropSession: async (reference, workspacePath) => {
    await call(await serverFor(workspacePath), workspacePath, `/api/session/${reference.sessionId}`, { method: "DELETE" });
  },
  tagSession: async (reference, tags, workspacePath) => {
    await call(await serverFor(workspacePath), workspacePath, `/api/session/${reference.sessionId}`, { method: "PATCH", body: JSON.stringify({ title: tags.nodeTitle, metadata: { boardId: tags.boardId, nodeId: tags.nodeId, source: "branchboard" } }) });
  },
  changedFiles: async (reference, workspacePath) => {
    const diff = await callJson(await serverFor(workspacePath), workspacePath, `/api/session/${reference.sessionId}/diff`);
    return (diff.data ?? []).map((entry: any) => String(entry.file));
  },
  compact: async (reference, workspacePath) => {
    await call(await serverFor(workspacePath), workspacePath, `/api/session/${reference.sessionId}/compact`, { method: "POST", body: JSON.stringify({}) });
  },
  titleModel: async (scope) => {
    const server = await serverFor(scope.workspacePath);
    return pickSmallModel(providersOf(await modelsOf(config, server, scope.workspacePath)), scope.model);
  },
  catalog: (workspacePath) => catalogOf(config, workspacePath),
  diagnostics: async () => ({ executable: config.executable?.(), servers: [...servers.keys()] }),
  openSession: async (plan, scope) => {
    const server = await serverFor(scope.workspacePath);
    const directory = scope.workspacePath;
    const created = plan.spine
      ? await callJson(server, directory, `/api/session/${plan.spine.runtimeRef.sessionId}/fork`, { method: "POST", body: JSON.stringify({ before: null }) }).catch((error) => {
          throw isNotFound(error) ? new RecoverableError(SESSION_GONE_MESSAGE, "assemble") : error;
        })
      : await callJson(server, directory, "/api/session", { method: "POST", body: JSON.stringify({ location: { directory }, agent: isChosen(scope.agent) ? scope.agent : undefined, model: modelRefOf(scope.model, scope.effort), permissions: permissionRulesOf(scope) }) });
    if (plan.spine && isChosen(scope.permissionMode)) await callJson(server, directory, `/api/session/${created.data.id}`, { method: "PATCH", body: JSON.stringify({ permissions: permissionRulesOf(scope) }) });
    const models = await modelsOf(config, server, directory).catch(() => []);
    const used = created.data.model ?? modelRefOf(scope.model, undefined);
    const contextWindow = models.find((model) => model.modelID === used?.id && model.providerID === used?.providerID)?.limit?.context;
    return { server, directory, sessionId: created.data.id as string, agent: created.data.agent, model: created.data.model, contextWindow, isFork: plan.spine !== undefined };
  },
  execute,
  control: async ({ server, directory, sessionId }, control) => {
    if (control.type === "background") await post(server, directory, `/api/session/${sessionId}/background`);
    else await post(server, directory, `/api/session/${sessionId}/prompt`, { text: control.text, delivery: "steer" });
  },
  eventMap: opencodeEventMap,
  rejectClosesRun: true,
  panels: async (workspacePath) => loadPanels(call, { server: await serverFor(workspacePath), directory: workspacePath }, panelSpecsOf(Boolean(config.providerIds))),
  panelAction: async (panelId, rowId, actionId, workspacePath) => {
    await runPanelAction(call, { server: await serverFor(workspacePath), directory: workspacePath }, panelSpecsOf(Boolean(config.providerIds)), panelId, rowId, actionId);
    listCache.clear();
  },
  answerRequest: async (request, answer, scope, message) => {
    if (!request.remoteId || !scope) return;
    const server = await serverFor(scope.workspacePath);
    if (request.kind === "question") return answerQuestion(server, scope.workspacePath, request, answer);
    return answerPermission(server, scope.workspacePath, request.remoteId, answer, message);
  },
});

const serverAddressStatus = (): CredentialStatus => {
  const address = configuredServerAddress();
  return { saved: Boolean(address?.password), baseUrl: address?.baseUrl ?? "" };
};

export const opencode2Runtime = createOpencode2Runtime({ id: "opencode2", pool: userInstallPool, executable: () => locateOpencodeGeneration2().path, credential: serverAddressStatus });
