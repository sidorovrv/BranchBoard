import { pathToFileURL } from "node:url";
import { decodeAnswers, isChosen, parseQuestionSpec, REJECTED_ANSWER, SESSION_GONE_MESSAGE, UNSET_CHOICE, type Catalog, type CatalogModel, type PendingRequest } from "@branchboard/core";
import { log } from "../log";
import { opencodeEventMap } from "./opencode";
import { locateOpencodeGeneration2 } from "./opencodeGeneration";
import { createServerPool, isNotFound, serverSentEvents, splitModel, type OpencodeServer } from "./opencodeServer";
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
}

const LIST_LOAD_ATTEMPTS = 10;
const LIST_LOAD_DELAY_MS = 500;
const SYSTEM_NOTE_KEY = "branchboard";

const { servers, call, callJson, post, serverFor } = createServerPool({
  logName: "opencode2",
  label: "OpenCode 2",
  healthPath: "/api/info",
  locate: locateOpencodeGeneration2,
  missingMessage: "The opencode2 command was not found. Install OpenCode 2 (npm install -g @opencode/cli) or set BRANCHBOARD_OPENCODE2_PATH to its full path.",
});

export const createSeen2 = (rootId: string): Seen2 => ({ rootId, childIds: new Set(), toolNames: new Map(), textLengths: new Map(), usage: new Map() });

const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const textOfContent = (content: unknown): string =>
  (Array.isArray(content) ? content : []).map((entry: any) => (typeof entry?.text === "string" ? entry.text : "")).filter(Boolean).join("\n");

const usageNative = (seen: Seen2): Opencode2Native => {
  const sessions = [...seen.usage.values()];
  const sum = (pick: (usage: SessionUsage) => number) => sessions.reduce((total, usage) => total + pick(usage), 0);
  return { type: "usage", inputTokens: sum((usage) => usage.input + usage.cacheRead + usage.cacheWrite), outputTokens: sum((usage) => usage.output), cacheReadTokens: sum((usage) => usage.cacheRead), cacheCreationTokens: sum((usage) => usage.cacheWrite), costUsd: sum((usage) => usage.cost) };
};

const questionOfForm = (form: any): Opencode2Native[] =>
  form?.metadata?.kind === "question"
    ? [{ type: "question", remoteId: `${form.sessionID}/${form.id}`, questions: (form.fields ?? []).map((field: any) => parseQuestionSpec({ question: field.description ?? field.title, header: field.title, options: (field.options ?? []).map((option: any) => ({ label: option.label ?? option.value, description: option.description })), multiple: field.type === "multiselect" })) }]
    : [];

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
    case "session.tool.failed":
      return [{ type: "tool-done", partId: data.id, output: String(data.error?.message ?? data.error?.type ?? "Tool failed"), isError: true }];
    case "permission.asked":
      return [{ type: "permission", remoteId: `${sessionId}/${data.id}`, title: data.message ?? data.action ?? "Permission requested", detail: Array.isArray(data.resources) ? data.resources.join(", ") || undefined : undefined }];
    case "form.created":
      return questionOfForm(data.form);
    case "session.execution.failed":
      return [{ type: "failure", message: String(data.error?.message ?? data.error?.type ?? "OpenCode 2 session failed") }];
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
    return [usageNative(seen)];
  }
  const events = translateSession(raw, sessionId, seen);
  if (sessionId === seen.rootId) return events;
  return events.map((inner): Opencode2Native => (inner.type === "idle" ? { type: "subagent-done", key: sessionId } : { type: "sub", key: sessionId, inner }));
};

const modelRefOf = (model: string | undefined, effort: string | undefined): ModelRef | undefined => {
  const parts = isChosen(model) ? splitModel(model) : undefined;
  return parts && { id: parts.modelID, providerID: parts.providerID, ...(isChosen(effort) ? { variant: effort } : {}) };
};

const sameModel = (current: ModelRef | undefined, wanted: ModelRef): boolean =>
  current?.id === wanted.id && current.providerID === wanted.providerID && (current.variant ?? "default") === (wanted.variant ?? "default");

const sessionPath = (handle: Opencode2Handle, suffix = "") => `/api/session/${handle.sessionId}${suffix}`;

const applyRunChoices = async (handle: Opencode2Handle, scope: RunScope) => {
  const { server, directory } = handle;
  const model = modelRefOf(scope.model, scope.effort);
  if (model && !sameModel(handle.model, model)) await post(server, directory, sessionPath(handle, "/model"), { model });
  if (isChosen(scope.agent) && scope.agent !== handle.agent) await post(server, directory, sessionPath(handle, "/agent"), { agent: scope.agent });
  if (scope.systemNote) await call(server, directory, `/api/experimental/session/${handle.sessionId}/instructions/entries/${SYSTEM_NOTE_KEY}`, { method: "PUT", body: JSON.stringify({ value: scope.systemNote }) });
};

const commandNamesOf = async (handle: Opencode2Handle): Promise<Set<string>> => {
  const listed = await callJson(handle.server, handle.directory, "/api/command").catch(() => ({ data: [] }));
  return new Set<string>((listed.data ?? []).map((entry: any) => String(entry.name)));
};

const sendInput = async (handle: Opencode2Handle, input: string, scope: RunScope) => {
  const { server, directory } = handle;
  const files = scope.files.map((file) => ({ uri: pathToFileURL(file.path).href, name: file.name }));
  const slash = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (slash && (await commandNamesOf(handle)).has(slash[1])) {
    await post(server, directory, sessionPath(handle, "/command"), { name: slash[1], text: slash[2] ?? "", files });
    return;
  }
  await post(server, directory, sessionPath(handle, "/prompt"), { text: input, files });
};

async function* execute(handle: Opencode2Handle, input: string, scope: RunScope): AsyncGenerator<Opencode2Native> {
  const { server, directory, sessionId } = handle;
  const stream = await call(server, directory, "/api/event", { signal: scope.signal });
  const seen = createSeen2(sessionId);
  scope.signal.addEventListener("abort", () => void post(server, directory, sessionPath(handle, "/interrupt")).catch(() => undefined), { once: true });
  await applyRunChoices(handle, scope);
  await sendInput(handle, input, scope);
  try {
    for await (const raw of serverSentEvents<Opencode2Native>(stream, scope.signal)) {
      for (const native of translateEvent2(raw, seen)) {
        yield native;
        if (native.type === "idle" || native.type === "failure") {
          scope.setRuntimeRef({ sessionId, lastMessageId: seen.lastAssistantMessage });
          return;
        }
      }
    }
  } catch (error) {
    if (scope.signal.aborted) log.info("opencode2", `Event stream for session ${sessionId} stopped`);
    else log.error("opencode2", `Event stream for session ${sessionId} broke`, error);
    throw error;
  } finally {
    scope.setRuntimeRef({ sessionId, lastMessageId: seen.lastAssistantMessage });
  }
}

const loadList = async (server: OpencodeServer, directory: string, path: string, keep: (entry: any) => boolean = () => true): Promise<any[]> => {
  for (let attempt = 1; ; attempt++) {
    const kept = ((await callJson(server, directory, path)).data ?? []).filter(keep);
    if (kept.length > 0 || attempt >= LIST_LOAD_ATTEMPTS) return kept;
    await new Promise((resolve) => setTimeout(resolve, LIST_LOAD_DELAY_MS));
  }
};

const loadModels = (server: OpencodeServer, directory: string) => loadList(server, directory, "/api/model", (model) => model.enabled);

const catalogModelOf = (model: any): CatalogModel => {
  const variants = (model.variants ?? []).map((variant: any) => String(variant.id));
  return { id: `${model.providerID}/${model.modelID}`, name: model.name ?? model.modelID, provider: model.providerID, contextWindow: model.limit?.context, efforts: variants.length > 0 ? [UNSET_CHOICE, ...variants] : undefined };
};

const catalog = async (workspacePath: string): Promise<Catalog> => {
  try {
    const server = await serverFor(workspacePath);
    const [agents, models, commands] = await Promise.all([
      loadList(server, workspacePath, "/api/agent", (agent) => agent.mode !== "subagent" && !agent.hidden),
      loadModels(server, workspacePath),
      loadList(server, workspacePath, "/api/command").catch(() => []),
    ]);
    return {
      agents: agents.map((agent) => String(agent.id)),
      models: models.map(catalogModelOf),
      commands: commands.map((entry) => ({ name: String(entry.name), description: entry.description, template: `/${entry.name} $ARGUMENTS`, passThrough: true })),
      health: { ok: true, detail: "connected to opencode2 serve" },
    };
  } catch (error) {
    log.error("opencode2", `Catalog failed for ${workspacePath}`, error);
    return { agents: [], models: [], health: { ok: false, detail: error instanceof Error ? error.message : String(error) } };
  }
};

const providersOf = (models: any[]) =>
  [...new Set<string>(models.map((model) => model.providerID))].map((id) => ({
    id,
    models: Object.fromEntries(models.filter((model) => model.providerID === id).map((model) => [model.modelID, { id: model.modelID, status: model.status, cost: model.cost?.[0], limit: model.limit }])),
  }));

const answerQuestion = async (server: OpencodeServer, directory: string, request: PendingRequest, answer: string) => {
  const [sessionId, formId] = String(request.remoteId).split("/");
  const path = `/api/session/${sessionId}/form/${formId}`;
  if (answer === REJECTED_ANSWER) {
    await call(server, directory, path, { method: "DELETE" });
    return;
  }
  const questions = request.questions ?? [];
  const grid = decodeAnswers(questions.length, answer);
  const reply = Object.fromEntries(questions.map((question, index) => [`q${index}`, question.multiple ? (grid[index] ?? []) : (grid[index]?.[0] ?? "")]));
  await post(server, directory, `${path}/reply`, { answer: reply });
};

const answerPermission = async (server: OpencodeServer, directory: string, remoteId: string, answer: string) => {
  const [sessionId, permissionId] = remoteId.split("/");
  await post(server, directory, `/api/session/${sessionId}/permission/${permissionId}/reply`, { decision: answer }).catch((error) => {
    if (!isNotFound(error)) throw error;
    log.info("opencode2", `Permission ${permissionId} was already settled by opencode`);
  });
};

export const opencode2Runtime: RuntimeSteps<Opencode2Native, Opencode2Handle> = {
  id: "opencode2",
  editsFiles: true,
  canSuggestTitles: true,
  titleModel: async (scope) => {
    const server = await serverFor(scope.workspacePath);
    return pickSmallModel(providersOf(await loadModels(server, scope.workspacePath)), scope.model);
  },
  catalog,
  diagnostics: async () => ({ executable: locateOpencodeGeneration2().path, servers: [...servers.keys()] }),
  openSession: async (plan, scope) => {
    const server = await serverFor(scope.workspacePath);
    const directory = scope.workspacePath;
    const created = plan.spine
      ? await callJson(server, directory, `/api/session/${plan.spine.runtimeRef.sessionId}/fork`, { method: "POST", body: JSON.stringify({ before: null }) }).catch((error) => {
          throw isNotFound(error) ? new RecoverableError(SESSION_GONE_MESSAGE, "assemble") : error;
        })
      : await callJson(server, directory, "/api/session", { method: "POST", body: JSON.stringify({ location: { directory }, agent: isChosen(scope.agent) ? scope.agent : undefined, model: modelRefOf(scope.model, scope.effort) }) });
    return { server, directory, sessionId: created.data.id as string, agent: created.data.agent, model: created.data.model };
  },
  execute,
  eventMap: opencodeEventMap,
  answerRequest: async (request, answer, scope) => {
    if (!request.remoteId || !scope) return;
    const server = await serverFor(scope.workspacePath);
    if (request.kind === "question") return answerQuestion(server, scope.workspacePath, request, answer);
    return answerPermission(server, scope.workspacePath, request.remoteId, answer);
  },
};
