import { pathToFileURL } from "node:url";
import { decodeAnswers, isChosen, parseQuestionSpec, REJECTED_ANSWER, SESSION_GONE_MESSAGE, UNSET_CHOICE, type Catalog, type CatalogCommand, type CatalogModel, type PendingRequest, type RunEvent } from "@branchboard/core";
import { approvalOpened, numberOf, questionOpened, streamEventMap, subagentEventMap, usageEvents, usageNative } from "./commonEvents";
import { log } from "../log";
import { locateOpencode } from "./opencodeLocator";
import { generateThroughSession } from "../run/askOnce";
import { failureOf } from "./failures";
import { closeStream, createServerPool, interruptOnAbort, isNotFound, opencodeSlots, serverSentEvents, splitModel, type OpencodeServer } from "./opencodeServer";
import { pickSmallModel } from "./smallModel";
import { RecoverableError, type EventMap, type NativeEvent, type RunScope, type RuntimeSteps } from "../run/types";

interface OpencodeHandle {
  server: OpencodeServer;
  sessionId: string;
  directory: string;
}

type OpencodeNative = NativeEvent & Record<string, any>;

const { servers, call, callJson, post, serverFor } = createServerPool({
  logName: "opencode",
  label: "OpenCode",
  healthPath: "/global/health",
  locate: locateOpencode,
  missingMessage: "The opencode command was not found. Install OpenCode (npm install -g opencode-ai) or set BRANCHBOARD_OPENCODE_PATH to its full path.",
});

const describeTool = (part: any): string => part.state?.input?.description ?? part.state?.title ?? part.tool ?? "tool";

const describePermissionTarget = (properties: any): string | undefined => {
  const target = properties.patterns ?? properties.pattern;
  if (Array.isArray(target)) return target.join(", ") || undefined;
  return target ? String(target) : undefined;
};

export interface SeenState {
  textLengths: Map<string, number>;
  partTypes: Map<string, string>;
  userMessages: Set<string>;
  children: Map<string, SeenState>;
  messageUsage: Map<string, MessageUsage>;
  lastAssistantMessage?: string;
  promptText?: string;
}

export const createSeenState = (): SeenState => ({ textLengths: new Map<string, number>(), partTypes: new Map<string, string>(), userMessages: new Set<string>(), children: new Map<string, SeenState>(), messageUsage: new Map<string, MessageUsage>() });

const sessionOfEvent = (raw: OpencodeNative): string | undefined => {
  const properties = raw.properties ?? {};
  return properties.sessionID ?? properties.part?.sessionID ?? properties.info?.sessionID;
};

const userPromptOf = (raw: OpencodeNative, sessionId: string, seen: SeenState): string | undefined => {
  const part = raw.properties?.part;
  if (raw.type !== "message.part.updated" || part?.sessionID !== sessionId || part.type !== "text" || !seen.userMessages.has(part.messageID)) return undefined;
  const text = String(part.text ?? "");
  if (!text || seen.promptText === text) return undefined;
  seen.promptText = text;
  return text;
};

interface MessageUsage {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const recordAssistantUsage = (raw: OpencodeNative, handle: Pick<OpencodeHandle, "sessionId">, seen: SeenState): boolean => {
  const info = raw.properties?.info;
  if (raw.type !== "message.updated" || info?.role !== "assistant" || typeof info.id !== "string") return false;
  const owner = info.sessionID === handle.sessionId ? seen : seen.children.get(info.sessionID);
  if (!owner) return false;
  const tokens = info.tokens ?? {};
  owner.messageUsage.set(info.id, { cost: numberOf(info.cost), input: numberOf(tokens.input), output: numberOf(tokens.output) + numberOf(tokens.reasoning), cacheRead: numberOf(tokens.cache?.read), cacheWrite: numberOf(tokens.cache?.write) });
  return true;
};

const totalUsageOf = (seen: SeenState): OpencodeNative => {
  const states = [seen, ...seen.children.values()];
  const messages = states.flatMap((state) => [...state.messageUsage.values()]);
  const sum = (pick: (message: MessageUsage) => number) => messages.reduce((total, message) => total + pick(message), 0);
  return usageNative({ inputTokens: sum((message) => message.input + message.cacheRead + message.cacheWrite), outputTokens: sum((message) => message.output), cacheReadTokens: sum((message) => message.cacheRead), cacheCreationTokens: sum((message) => message.cacheWrite), costUsd: sum((message) => message.cost) });
};

export const translateEvent = (raw: OpencodeNative, handle: Pick<OpencodeHandle, "sessionId">, seen: SeenState): OpencodeNative[] => {
  const events = translateContent(raw, handle, seen);
  return recordAssistantUsage(raw, handle, seen) ? [...events, totalUsageOf(seen)] : events;
};

const translateContent = (raw: OpencodeNative, handle: Pick<OpencodeHandle, "sessionId">, seen: SeenState): OpencodeNative[] => {
  const properties = raw.properties ?? {};
  if (raw.type === "session.created" && properties.info?.parentID === handle.sessionId) {
    seen.children.set(properties.info.id, createSeenState());
    return [{ type: "subagent-start", key: properties.info.id, title: String(properties.info.title ?? "Subagent"), agent: properties.info.agent ?? /\(@([\w.-]+) subagent\)/i.exec(String(properties.info.title ?? ""))?.[1] }];
  }
  const childId = sessionOfEvent(raw);
  const child = childId ? seen.children.get(childId) : undefined;
  if (childId && child) {
    const prompt = userPromptOf(raw, childId, child);
    if (prompt) return [{ type: "sub", key: childId, inner: { type: "user-prompt", text: prompt } }];
    return translateSessionEvent(raw, childId, child).map((inner): OpencodeNative => (inner.type === "idle" ? { type: "subagent-done", key: childId } : { type: "sub", key: childId, inner }));
  }
  return translateSessionEvent(raw, handle.sessionId, seen);
};

const translateSessionEvent = (raw: OpencodeNative, sessionId: string, seen: SeenState): OpencodeNative[] => {
  const properties = raw.properties ?? {};
  if (raw.type === "todo.updated" && properties.sessionID === sessionId) return [{ type: "todos", items: properties.todos }];
  if (raw.type === "message.updated" && properties.info?.role === "user") seen.userMessages.add(properties.info.id);
  if (raw.type === "message.part.updated") {
    const part = properties.part;
    if (!part || part.sessionID !== sessionId || seen.userMessages.has(part.messageID)) return [];
    seen.lastAssistantMessage = part.messageID;
    seen.partTypes.set(part.id, part.type);
    if (part.type === "text" || part.type === "reasoning") {
      const previous = seen.textLengths.get(part.id) ?? 0;
      seen.textLengths.set(part.id, (part.text ?? "").length);
      const delta = (part.text ?? "").slice(previous);
      return delta ? [{ type: part.type, partId: part.id, delta }] : [];
    }
    if (part.type === "tool" && part.state?.status === "running") return [{ type: "tool-start", partId: part.id, tool: part.tool, description: describeTool(part), input: part.state.input }];
    if (part.type === "tool" && ["completed", "error"].includes(part.state?.status))
      return [{ type: "tool-done", partId: part.id, output: String(part.state.output ?? part.state.error ?? ""), isError: part.state.status === "error" }];
    return [];
  }
  if (raw.type === "message.part.delta") {
    const partId = properties.partID;
    const partType = seen.partTypes.get(partId) ?? "text";
    if (properties.sessionID !== sessionId || seen.userMessages.has(properties.messageID) || properties.field !== "text" || !properties.delta) return [];
    if (partType !== "text" && partType !== "reasoning") return [];
    seen.lastAssistantMessage = properties.messageID;
    seen.textLengths.set(partId, (seen.textLengths.get(partId) ?? 0) + properties.delta.length);
    return [{ type: partType, partId, delta: properties.delta }];
  }
  const isPermission = raw.type === "permission.updated" || raw.type === "permission.asked";
  if (isPermission && properties.sessionID === sessionId)
    return [{ type: "permission", remoteId: `${sessionId}/${properties.id}`, title: properties.title ?? properties.permission ?? "Permission requested", detail: describePermissionTarget(properties) }];
  if (raw.type === "question.asked" && properties.sessionID === sessionId) return [{ type: "question", remoteId: properties.id, questions: (properties.questions ?? []).map(parseQuestionSpec) }];
  if (raw.type === "session.error" && properties.sessionID === sessionId) return [{ type: "failure", message: properties.error?.data?.message ?? properties.error?.name ?? "OpenCode session error" }];
  if (raw.type === "session.idle" && properties.sessionID === sessionId) return [{ type: "idle" }];
  return [];
};

async function* execute(handle: OpencodeHandle, input: string, scope: RunScope): AsyncGenerator<OpencodeNative> {
  const { server, directory, sessionId } = handle;
  const stream = await call(server, directory, "/event", { signal: scope.signal });
  const seen = createSeenState();
  const interrupts = interruptOnAbort(scope.signal, () => call(server, directory, `/session/${sessionId}/abort`, { method: "POST" }));
  try {
    const model = isChosen(scope.model) ? scope.model : isChosen(scope.effort) ? await configuredModelOf(server, directory) : undefined;
    await call(server, directory, `/session/${sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ agent: scope.agent, model: splitModel(model), variant: isChosen(scope.effort) ? scope.effort : undefined, system: [scope.systemNote, scope.contextNote].filter(Boolean).join("\n\n") || undefined, parts: [{ type: "text", text: input }, ...scope.files.map((file) => ({ type: "file", mime: file.mime, filename: file.name, url: pathToFileURL(file.path).href }))] }),
    });
    interrupts.resendIfAborted();
    for await (const raw of serverSentEvents<OpencodeNative>(stream, scope.signal)) {
      for (const native of translateEvent(raw, handle, seen)) {
        yield native;
        if (native.type === "idle" || native.type === "failure") return;
      }
    }
    if (!scope.signal.aborted) yield { type: "failure", ...failureOf({ isEarlyEnd: true }) };
  } catch (error) {
    if (scope.signal.aborted) log.info("opencode", `Event stream for session ${sessionId} stopped`);
    else log.error("opencode", `Event stream for session ${sessionId} broke`, error);
    throw error;
  } finally {
    interrupts.stop();
    closeStream(stream);
    scope.setRuntimeRef({ sessionId, lastMessageId: seen.lastAssistantMessage });
  }
}

export const opencodeEventMap: EventMap<OpencodeNative> = {
  ...streamEventMap,
  ...subagentEventMap(() => opencodeEventMap),
  usage: usageEvents,
  permission: (native) => approvalOpened({ id: `permission:${native.remoteId}`, remoteId: native.remoteId, title: native.title, detail: native.detail }),
  question: (native) => questionOpened({ id: `question:${native.remoteId}`, remoteId: native.remoteId, questions: native.questions }),
  retry: (native) => [{ type: "retry", attempt: native.attempt, at: native.at, reason: native.reason }],
  compacted: () => [{ type: "context.compacted" }],
  "retry-restart": (native) => [{ type: "retry-restart", partKeys: native.partKeys }],
  failure: (native) => [{ type: "error", message: native.message, recovery: native.recovery }],
  idle: () => [{ type: "done" }],
};

const effortsOf = (model: any): string[] | undefined => {
  const variants = Object.keys(model.variants ?? {});
  return variants.length > 0 ? [UNSET_CHOICE, ...variants] : undefined;
};

const configuredModelOf = async (server: OpencodeServer, directory: string): Promise<string | undefined> => {
  const config = await callJson(server, directory, "/config").catch(() => undefined);
  return typeof config?.model === "string" && config.model.includes("/") ? config.model : undefined;
};

const catalog = async (workspacePath: string): Promise<Catalog> => {
  try {
    const server = await serverFor(workspacePath);
    const [agents, providers, commandList, defaultModel] = await Promise.all([
      callJson(server, workspacePath, "/agent"),
      callJson(server, workspacePath, "/config/providers"),
      callJson(server, workspacePath, "/command").catch(() => []),
      configuredModelOf(server, workspacePath),
    ]);
    const commands: CatalogCommand[] = (Array.isArray(commandList) ? commandList : [])
      .filter((entry: any) => typeof entry?.name === "string" && typeof entry?.template === "string")
      .map((entry: any) => ({ name: entry.name, description: entry.description, template: entry.template }));
    const models: CatalogModel[] = (providers.providers ?? []).flatMap((provider: any) =>
      Object.values<any>(provider.models ?? {}).map((model) => ({ id: `${provider.id}/${model.id}`, name: model.name ?? model.id, provider: provider.name ?? provider.id, contextWindow: model.limit?.context, efforts: effortsOf(model) })),
    );
    const primaryAgents = (agents as any[]).filter((agent) => agent.mode !== "subagent" && !agent.hidden).map((agent) => agent.name as string);
    return { agents: primaryAgents, models, commands, defaultModel, meters: ["cost"], health: { ok: true, detail: "connected to opencode serve" } };
  } catch (error) {
    log.error("opencode", `Catalog failed for ${workspacePath}`, error);
    return { agents: [], models: [], health: { ok: false, detail: error instanceof Error ? error.message : String(error) } };
  }
};

const answerQuestion = async (server: OpencodeServer, directory: string, request: PendingRequest, answer: string) => {
  if (answer === REJECTED_ANSWER) {
    await post(server, directory, `/question/${request.remoteId}/reject`);
    return;
  }
  await post(server, directory, `/question/${request.remoteId}/reply`, { answers: decodeAnswers(request.questions?.length ?? 1, answer) });
};

const answerPermission = async (server: OpencodeServer, directory: string, remoteId: string, answer: string) => {
  const [sessionId, permissionId] = remoteId.split("/");
  try {
    await post(server, directory, `/permission/${permissionId}/reply`, { reply: answer });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await post(server, directory, `/session/${sessionId}/permissions/${permissionId}`, { response: answer }).catch((fallbackError) => {
      if (!isNotFound(fallbackError)) throw fallbackError;
      log.info("opencode", `Permission ${permissionId} was already settled by opencode`);
    });
  }
};

export const opencode1Runtime: RuntimeSteps<OpencodeNative, OpencodeHandle> = {
  id: "opencode",
  editsFiles: true,
  canSuggestTitles: true,
  slots: opencodeSlots,
  generateText: generateThroughSession(() => opencode1Runtime),
  dropSession: async (reference, workspacePath) => {
    await call(await serverFor(workspacePath), workspacePath, `/session/${reference.sessionId}`, { method: "DELETE" });
  },
  titleModel: async (scope) => {
    const server = await serverFor(scope.workspacePath);
    const config = await callJson(server, scope.workspacePath, "/config");
    if (typeof config?.small_model === "string" && config.small_model.includes("/")) return config.small_model;
    const providers = await callJson(server, scope.workspacePath, "/config/providers");
    return pickSmallModel(Array.isArray(providers?.providers) ? providers.providers : [], scope.model);
  },
  catalog,
  diagnostics: async () => ({ executable: locateOpencode().path, servers: [...servers.keys()] }),
  openSession: async (plan, scope) => {
    const server = await serverFor(scope.workspacePath);
    const directory = scope.workspacePath;
    const created = plan.spine
      ? await callJson(server, directory, `/session/${plan.spine.runtimeRef.sessionId}/fork`, { method: "POST", body: JSON.stringify({}) }).catch((error) => {
          throw isNotFound(error) ? new RecoverableError(SESSION_GONE_MESSAGE, "assemble") : error;
        })
      : await callJson(server, directory, "/session", { method: "POST", body: JSON.stringify({}) });
    return { server, directory, sessionId: created.id as string };
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
