import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { decodeAnswers, isChosen, parseQuestionSpec, REJECTED_ANSWER, UNSET_CHOICE, type Catalog, type CatalogCommand, type CatalogModel, type PendingRequest, type RunEvent } from "@branchboard/core";
import { approvalOpened, questionOpened, streamEventMap, subagentEventMap } from "./commonEvents";
import { log } from "../log";
import { locateOpencode } from "./opencodeLocator";
import { pickSmallModel } from "./smallModel";
import { killTree, withoutCurrentDirectorySearch } from "./spawnProcess";
import type { EventMap, NativeEvent, RunScope, RuntimeSteps } from "../run/types";

interface OpencodeServer {
  baseUrl: string;
  authorization: string;
  child?: ChildProcess;
}

interface OpencodeHandle {
  server: OpencodeServer;
  sessionId: string;
  directory: string;
}

type OpencodeNative = NativeEvent & Record<string, any>;

const STARTUP_TIMEOUT_MS = 20000;
const OUTPUT_TAIL_CHARS = 2000;
const PROGRESS_LOG_MS = 3000;
const servers = new Map<string, Promise<OpencodeServer>>();

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

const call = async (server: OpencodeServer, directory: string, path: string, init: RequestInit = {}) => {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${server.baseUrl}${path}${separator}directory=${encodeURIComponent(directory)}`, {
    ...init,
    headers: { authorization: server.authorization, "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    log.error("opencode", `${init.method ?? "GET"} ${path} failed with ${response.status}`, body);
    throw new Error(`OpenCode ${path} failed with ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  return response;
};

const callJson = async (server: OpencodeServer, directory: string, path: string, init?: RequestInit) =>
  (await call(server, directory, path, init)).json() as Promise<any>;

const waitUntilHealthy = async (server: OpencodeServer) => {
  const started = Date.now();
  const deadline = started + STARTUP_TIMEOUT_MS;
  let lastReason = "no response yet";
  let nextProgressLog = started + PROGRESS_LOG_MS;
  while (Date.now() < deadline && server.child?.exitCode == null) {
    const healthy = await fetch(`${server.baseUrl}/global/health`, { headers: { authorization: server.authorization } }).then(
      (response) => {
        if (!response.ok) lastReason = `health returned ${response.status}`;
        return response.ok;
      },
      (error) => {
        lastReason = `connection failed: ${error?.cause?.code ?? error?.message ?? error}`;
        return false;
      },
    );
    if (healthy) {
      log.info("opencode", `Server healthy after ${Date.now() - started}ms at ${server.baseUrl}`);
      return;
    }
    if (Date.now() >= nextProgressLog) {
      log.warn("opencode", `Still waiting for ${server.baseUrl} (${Date.now() - started}ms, ${lastReason})`);
      nextProgressLog += PROGRESS_LOG_MS;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (server.child?.exitCode != null) throw new Error("opencode serve exited before becoming healthy");
  log.error("opencode", `Gave up waiting for ${server.baseUrl} after ${STARTUP_TIMEOUT_MS}ms (${lastReason})`);
  throw new Error("opencode serve did not become healthy in time");
};

const startServer = async (directory: string): Promise<OpencodeServer> => {
  const located = locateOpencode();
  if (!located.path) {
    log.error("opencode", "Could not find the opencode executable", located.searched.join("\n"));
    throw new Error("The opencode command was not found. Install OpenCode (npm install -g opencode-ai) or set BRANCHBOARD_OPENCODE_PATH to its full path.");
  }
  const password = randomBytes(16).toString("hex");
  const port = await freePort();
  log.info("opencode", `Spawning ${located.path} serve on port ${port} in ${directory}`);
  const isWindows = process.platform === "win32";
  const child = spawn(isWindows ? `"${located.path}"` : located.path, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env: withoutCurrentDirectorySearch({ ...process.env, OPENCODE_SERVER_PASSWORD: password }),
    shell: isWindows,
    stdio: ["ignore", "pipe", "pipe"],
  });
  log.debug("opencode", `Spawned pid ${child.pid}`);
  let output = "";
  const remember = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
    chunk.toString().split(/\r?\n/).filter(Boolean).forEach((line) => log.debug("opencode", `pid ${child.pid}: ${line}`));
  };
  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);
  const failure = new Promise<never>((_resolve, reject) => {
    child.on("error", (error) => {
      log.error("opencode", `Could not spawn ${located.path}`, error);
      reject(new Error(`Could not start opencode: ${error.message}. Is OpenCode installed and on PATH?`));
    });
    child.on("exit", (code, signal) => {
      log.error("opencode", `opencode serve (pid ${child.pid}) exited with code ${code} signal ${signal}`, output.trim() || undefined);
      servers.delete(directory);
      reject(new Error(`opencode serve exited with code ${code} in ${directory}. ${output.trim()}`));
    });
  });
  failure.catch(() => undefined);
  const server: OpencodeServer = { baseUrl: `http://127.0.0.1:${port}`, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, child };
  process.on("exit", () => killTree(child));
  try {
    await Promise.race([waitUntilHealthy(server), failure]);
  } catch (error) {
    killTree(child);
    if (error instanceof Error && error.message.startsWith("opencode serve did not")) throw new Error(`${error.message} ${output.trim()}`);
    throw error;
  }
  return server;
};

const serverFor = (directory: string): Promise<OpencodeServer> => {
  const existing = servers.get(directory);
  if (existing) return existing;
  const started = startServer(directory);
  servers.set(directory, started);
  started.catch(() => servers.delete(directory));
  return started;
};

const splitModel = (model: string | undefined) => {
  if (!model || !model.includes("/")) return undefined;
  const [providerID, ...rest] = model.split("/");
  return { providerID, modelID: rest.join("/") };
};

async function* serverSentEvents(response: Response, signal: AbortSignal): AsyncGenerator<OpencodeNative> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (signal.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
      if (data) yield JSON.parse(data) as OpencodeNative;
    }
  }
}

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

const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

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
  return { type: "usage", inputTokens: sum((message) => message.input + message.cacheRead + message.cacheWrite), outputTokens: sum((message) => message.output), cacheReadTokens: sum((message) => message.cacheRead), cacheCreationTokens: sum((message) => message.cacheWrite), costUsd: sum((message) => message.cost) };
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
  scope.signal.addEventListener("abort", () => void call(server, directory, `/session/${sessionId}/abort`, { method: "POST" }).catch(() => undefined), { once: true });
  await call(server, directory, `/session/${sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ agent: scope.agent, model: splitModel(scope.model), variant: isChosen(scope.effort) ? scope.effort : undefined, system: scope.systemNote, parts: [{ type: "text", text: input }, ...scope.files.map((file) => ({ type: "file", mime: file.mime, filename: file.name, url: pathToFileURL(file.path).href }))] }),
  });
  try {
    for await (const raw of serverSentEvents(stream, scope.signal)) {
      for (const native of translateEvent(raw, handle, seen)) {
        yield native;
        if (native.type === "idle" || native.type === "failure") {
          scope.setRuntimeRef({ sessionId, lastMessageId: seen.lastAssistantMessage });
          return;
        }
      }
    }
  } catch (error) {
    if (scope.signal.aborted) log.info("opencode", `Event stream for session ${sessionId} stopped`);
    else log.error("opencode", `Event stream for session ${sessionId} broke`, error);
    throw error;
  } finally {
    scope.setRuntimeRef({ sessionId, lastMessageId: seen.lastAssistantMessage });
  }
}

export const opencodeEventMap: EventMap<OpencodeNative> = {
  ...streamEventMap,
  ...subagentEventMap(() => opencodeEventMap),
  usage: (native) => [{ type: "usage", usage: { inputTokens: native.inputTokens, outputTokens: native.outputTokens, cacheReadTokens: native.cacheReadTokens, cacheCreationTokens: native.cacheCreationTokens, costUsd: native.costUsd } }],
  permission: (native) => approvalOpened({ id: `permission:${native.remoteId}`, remoteId: native.remoteId, title: native.title, detail: native.detail }),
  question: (native) => questionOpened({ id: `question:${native.remoteId}`, remoteId: native.remoteId, questions: native.questions }),
  failure: (native) => [{ type: "error", message: native.message }],
  idle: () => [{ type: "done" }],
};

const effortsOf = (model: any): string[] | undefined => {
  const variants = Object.keys(model.variants ?? {});
  return variants.length > 0 ? [UNSET_CHOICE, ...variants] : undefined;
};

const catalog = async (workspacePath: string): Promise<Catalog> => {
  try {
    const server = await serverFor(workspacePath);
    const [agents, providers, commandList] = await Promise.all([
      callJson(server, workspacePath, "/agent"),
      callJson(server, workspacePath, "/config/providers"),
      callJson(server, workspacePath, "/command").catch(() => []),
    ]);
    const commands: CatalogCommand[] = (Array.isArray(commandList) ? commandList : [])
      .filter((entry: any) => typeof entry?.name === "string" && typeof entry?.template === "string")
      .map((entry: any) => ({ name: entry.name, description: entry.description, template: entry.template }));
    const models: CatalogModel[] = (providers.providers ?? []).flatMap((provider: any) =>
      Object.values<any>(provider.models ?? {}).map((model) => ({ id: `${provider.id}/${model.id}`, name: model.name ?? model.id, provider: provider.name ?? provider.id, contextWindow: model.limit?.context, efforts: effortsOf(model) })),
    );
    const primaryAgents = (agents as any[]).filter((agent) => agent.mode !== "subagent").map((agent) => agent.name as string);
    return { agents: primaryAgents, models, commands, health: { ok: true, detail: "connected to opencode serve" } };
  } catch (error) {
    log.error("opencode", `Catalog failed for ${workspacePath}`, error);
    return { agents: [], models: [], health: { ok: false, detail: error instanceof Error ? error.message : String(error) } };
  }
};

const post = (server: OpencodeServer, directory: string, path: string, body?: unknown) =>
  call(server, directory, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

const answerQuestion = async (server: OpencodeServer, directory: string, request: PendingRequest, answer: string) => {
  if (answer === REJECTED_ANSWER) {
    await post(server, directory, `/question/${request.remoteId}/reject`);
    return;
  }
  await post(server, directory, `/question/${request.remoteId}/reply`, { answers: decodeAnswers(request.questions?.length ?? 1, answer) });
};

const isNotFound = (error: unknown): boolean => error instanceof Error && error.message.includes("failed with 404");

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

export const opencodeRuntime: RuntimeSteps<OpencodeNative, OpencodeHandle> = {
  id: "opencode",
  canSuggestTitles: true,
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
      ? await callJson(server, directory, `/session/${plan.spine.runtimeRef.sessionId}/fork`, { method: "POST", body: JSON.stringify({}) })
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
