import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, REJECTED_ANSWER, SESSION_GONE_MESSAGE, UNSET_CHOICE, type Catalog, type CatalogModel, type QuestionSpec } from "@branchboard/core";
import { createLimitsStore, type LimitsStore } from "../limits";
import { log } from "../log";
import { ONE_SHOT_SYSTEM_PROMPTS } from "../run/askOnce";
import { createLimiter, type Limiter } from "../run/limiter";
import { RecoverableError, type GenerateText, type RunScope, type RuntimeDiagnostics, type RuntimeSteps } from "../run/types";
import { VERSION } from "../version";
import { askApproval, createApprovalMemory, waitForReply } from "./approvalMemory";
import { CODEX_PATH_VARIABLE, locateCodex } from "./codexLocator";
import {
  commandTextOf,
  createCodexState,
  DEFAULT_PERMISSION_MODE,
  elicitationContent,
  fileChangePaths,
  isRunMessage,
  limitsInfoOf,
  PERMISSION_MODES,
  questionsOfElicitation,
  questionsOfUserInput,
  threadOpenRequest,
  threadSettings,
  translateCodexMessage,
  turnStartParams,
  userInputAnswers,
  type CodexHandle,
  type CodexRunState,
  type SkillRef,
} from "./codexStream";
import { approvalOpened, doneEvents, questionOpened, streamEventMap, subagentEventMap, usageEvents, type LooseNative } from "./commonEvents";
import type { Location } from "./executableLocator";
import { startJsonRpcProcess, type JsonRpcProcess, type RpcMessage } from "./jsonRpcProcess";
import { LIGHT_NAMES } from "./smallModel";
import { launchProcess, readOutput, type LaunchProcess, type ProcessExit } from "./spawnProcess";
import { createStreamRuntime } from "./streamRuntime";

export const MIN_CODEX_VERSION = [0, 163, 0];
export const MAX_CONCURRENT_TURNS = 2;
export const CODEX_INSTALL_COMMAND = "npm install -g @openai/codex";

const THREAD_GONE_PATTERN = /no rollout found|thread not found|unknown thread/i;
const THREAD_STILL_FORKED_PATTERN = /forked history still references it/i;
const SANDBOX_READY = "ready";
const MODEL_PAGE_LIMIT = 100;
const MAX_MODEL_PAGES = 10;
const DEFAULT_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"];
const ONE_SHOT_TIMEOUT_MS = 120_000;

export interface CodexDependencies {
  limits: LimitsStore;
  locate: () => Location;
  launch: LaunchProcess;
  probeVersion: (executable: string) => Promise<string>;
  limiter: Limiter;
  privateDirectory: () => string;
  environment: () => NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

interface Connection {
  rpc: JsonRpcProcess;
  executable: string;
}

interface RunRoute {
  scope: RunScope;
  push: (native: LooseNative) => void;
  threads?: Set<string>;
}

let privateDirectory: string | undefined;

const createPrivateDirectory = (): string => (privateDirectory ??= mkdtempSync(join(tmpdir(), "branchboard-codex-")));

export const parseCodexVersion =(output: string): number[] | undefined => /(\d+)\.(\d+)\.(\d+)/.exec(output)?.slice(1, 4).map(Number);

export const isSupportedCodexVersion = (version: number[]): boolean => {
  for (let index = 0; index < MIN_CODEX_VERSION.length; index++) {
    if (version[index] !== MIN_CODEX_VERSION[index]) return (version[index] ?? 0) > MIN_CODEX_VERSION[index]!;
  }
  return true;
};

const describeExit = (exit: ProcessExit): string => `The codex command exited with code ${exit.code} before finishing${exit.stderrTail ? `: ${exit.stderrTail}` : ""}`;

const decisionOf = (answer: string, available: unknown, isStopped: boolean): string => {
  const offered = Array.isArray(available) ? available.filter((decision): decision is string => typeof decision === "string") : DEFAULT_DECISIONS;
  const pick = (...preferred: string[]) => preferred.find((decision) => offered.includes(decision)) ?? preferred[preferred.length - 1]!;
  if (answer === "once") return "accept";
  if (answer === "always") return pick("acceptForSession", "accept");
  return isStopped ? pick("cancel", "decline") : pick("decline", "cancel");
};

const grantedPermissions = (requested: any) => Object.fromEntries(Object.entries(requested ?? {}).filter(([, value]) => value !== null && value !== undefined));

const describePermissions = (params: any): string => {
  const requested = params.permissions ?? {};
  const lines = [
    params.reason,
    requested.network?.enabled ? "Network access" : undefined,
    ...(requested.fileSystem?.read ?? []).map((path: string) => `Read ${path}`),
    ...(requested.fileSystem?.write ?? []).map((path: string) => `Write ${path}`),
  ];
  return lines.filter(Boolean).join("\n");
};

const modelsOf = (data: any[]): CatalogModel[] =>
  data.map((model) => ({
    id: String(model.id),
    name: String(model.displayName ?? model.id),
    provider: "codex",
    efforts: [UNSET_CHOICE, ...(Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((option: any) => String(option.reasoningEffort)) : [])],
  }));

const signInDetail = (account: any): string => (account?.type === "chatgpt" ? `signed in with ChatGPT${account.planType ? ` (${account.planType})` : ""}` : account?.type === "apiKey" ? "signed in with an API key" : "signed in");

export const createCodexRuntime = (overrides: Partial<CodexDependencies> = {}): RuntimeSteps<LooseNative, CodexHandle> => {
  const dependencies: CodexDependencies = {
    limits: createLimitsStore().of("codex"),
    locate: () => locateCodex(),
    launch: launchProcess,
    probeVersion: (executable) => readOutput(executable, ["--version"], { cwd: tmpdir(), env: process.env }),
    limiter: createLimiter(MAX_CONCURRENT_TURNS),
    privateDirectory: createPrivateDirectory,
    environment: () => process.env,
    platform: process.platform,
    ...overrides,
  };
  const approvalMemory = createApprovalMemory();
  const routes = new Set<RunRoute>();
  const fileChangeDetails = new Map<string, string>();
  const skillPaths = new Map<string, Map<string, string>>();
  const lightModels = new Map<string, string | undefined>();
  let connection: Promise<Connection> | undefined;
  let oneShotTurns = 0;

  const routeOf = (threadId: unknown): RunRoute | undefined => [...routes].find((route) => typeof threadId === "string" && route.threads?.has(threadId));

  const trackFileChanges = (message: RpcMessage) => {
    const item = message.params?.item;
    if (item?.type !== "fileChange") return;
    if (message.method === "item/completed") return void fileChangeDetails.delete(item.id);
    const workspacePath = routeOf(message.params.threadId)?.scope.workspacePath ?? "";
    if (message.method === "item/started") fileChangeDetails.set(item.id, fileChangePaths(workspacePath, item.changes).join("\n"));
  };

  const askQuestions = (route: RunRoute, questions: QuestionSpec[]): Promise<string> => {
    const requestId = newId();
    const reply = waitForReply(route.scope, requestId);
    route.push({ type: "question", requestId, questions });
    return reply;
  };

  const approve = async (route: RunRoute, params: any, ask: Parameters<typeof askApproval>[3]) => {
    const answer = await askApproval(route.scope, route.push, approvalMemory, ask);
    return { decision: decisionOf(answer, params.availableDecisions, route.scope.signal.aborted) };
  };

  const serverRequestHandlers: Record<string, (route: RunRoute, params: any) => Promise<unknown>> = {
    "item/commandExecution/requestApproval": (route, params) => {
      const command = commandTextOf(params);
      return approve(route, params, { tool: "bash", memoryDetail: command, title: command ? "Allow command?" : "Allow network access?", detail: command || params.reason || undefined });
    },
    "item/fileChange/requestApproval": (route, params) =>
      approve(route, params, { tool: "patch", title: "Allow file changes?", detail: fileChangeDetails.get(params.itemId) || params.reason || params.grantRoot || undefined }),
    "item/permissions/requestApproval": async (route, params) => {
      const answer = await askApproval(route.scope, route.push, approvalMemory, { tool: "permissions", memoryDetail: JSON.stringify(params.permissions ?? {}), title: "Allow extra access?", detail: describePermissions(params) || undefined });
      if (answer === REJECTED_ANSWER) return { permissions: {}, scope: "turn" };
      return { permissions: grantedPermissions(params.permissions), scope: answer === "always" ? "session" : "turn" };
    },
    "item/tool/requestUserInput": async (route, params) => {
      const { ids, questions } = questionsOfUserInput(params.questions);
      if (questions.length === 0) return { answers: {} };
      const raw = await askQuestions(route, questions);
      return raw === REJECTED_ANSWER ? { answers: {} } : userInputAnswers(ids, questions, raw);
    },
    "mcpServer/elicitation/request": async (route, params) => {
      const isSupported = params.mode === "form" || params.mode === "url";
      const { keys, questions } = isSupported ? questionsOfElicitation(params) : { keys: [], questions: [] };
      const raw = questions.length > 0 ? await askQuestions(route, questions) : REJECTED_ANSWER;
      if (raw === REJECTED_ANSWER) return { action: route.scope.signal.aborted ? "cancel" : "decline", content: null, _meta: null };
      return { action: "accept", content: params.mode === "form" ? elicitationContent(keys, questions, raw) : null, _meta: null };
    },
  };

  const handleServerRequest = async (method: string, params: any): Promise<unknown> => {
    const handler = serverRequestHandlers[method];
    if (!handler) throw new Error(`${method} is not supported by Branchboard`);
    const route = routeOf(params?.threadId);
    if (!route) throw new Error("No Branchboard run owns this thread");
    return handler(route, params);
  };

  const missingMessage = () => `The codex command was not found. Install it with ${CODEX_INSTALL_COMMAND}, sign in by running codex login, or set ${CODEX_PATH_VARIABLE} to its full path.`;

  const openConnection = async (): Promise<Connection> => {
    const located = dependencies.locate();
    if (!located.path) throw new RecoverableError(missingMessage(), "setup");
    const running = dependencies.launch(located.path, ["app-server"], { cwd: dependencies.privateDirectory(), env: dependencies.environment() });
    const rpc = startJsonRpcProcess(running, "codex");
    rpc.onServerRequest(handleServerRequest);
    rpc.onNotification(trackFileChanges);
    try {
      await rpc.request("initialize", { clientInfo: { name: "branchboard", title: "Branchboard", version: VERSION }, capabilities: { experimentalApi: false, requestAttestation: false } });
      rpc.notify("initialized");
    } catch (error) {
      rpc.kill();
      throw error;
    }
    log.info("codex", `Started ${located.path} app-server`);
    return { rpc, executable: located.path };
  };

  const connect = (): Promise<Connection> => {
    if (connection) return connection;
    const opening = openConnection();
    connection = opening;
    opening.then(
      ({ rpc }) =>
        void rpc.exit.then((exit) => {
          log.warn("codex", describeExit(exit));
          if (connection === opening) connection = undefined;
        }),
      () => {
        if (connection === opening) connection = undefined;
      },
    );
    return opening;
  };

  const forgetCaches = async () => {
    lightModels.clear();
    skillPaths.clear();
    const current = connection;
    if (!current || routes.size > 0 || oneShotTurns > 0) return;
    connection = undefined;
    await current.then(({ rpc }) => rpc.kill(), () => undefined);
  };

  const listModels = async (rpc: JsonRpcProcess): Promise<any[]> => {
    const models: any[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const result = await rpc.request("model/list", { includeHidden: false, limit: MODEL_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
      models.push(...(result?.data ?? []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return models;
  };

  const listSkills = async (rpc: JsonRpcProcess, workspacePath: string) => {
    const result = await rpc.request("skills/list", { cwds: [workspacePath] }).catch(() => undefined);
    const skills = (result?.data ?? []).flatMap((entry: any) => entry.skills ?? []).filter((skill: any) => skill.enabled !== false);
    skillPaths.set(workspacePath, new Map(skills.map((skill: any) => [String(skill.name), String(skill.path)])));
    return skills.map((skill: any) => ({ id: String(skill.name), name: String(skill.interface?.displayName ?? skill.name), description: skill.shortDescription ?? skill.description }));
  };

  const recordLimits = async (rpc: JsonRpcProcess) => {
    const result = await rpc.request("account/rateLimits/read").catch(() => undefined);
    const info = limitsInfoOf(result?.rateLimits);
    if (info) dependencies.limits.record(info);
  };

  const unhealthy = (detail: string, models: CatalogModel[] = []): Catalog => ({ agents: [], models, health: { ok: false, detail } });

  const catalog = async (workspacePath: string): Promise<Catalog> => {
    const located = dependencies.locate();
    if (!located.path) return unhealthy(missingMessage());
    try {
      const versionOutput = await dependencies.probeVersion(located.path);
      const version = parseCodexVersion(versionOutput);
      if (!version || !isSupportedCodexVersion(version)) return unhealthy(`Branchboard needs codex ${MIN_CODEX_VERSION.join(".")} or newer and found ${versionOutput || "an unknown version"}. Update it with ${CODEX_INSTALL_COMMAND}, then Check again.`);
      const { rpc } = await connect();
      const accountState = await rpc.request("account/read", {});
      if (accountState?.requiresOpenaiAuth && !accountState.account) return unhealthy("Run `codex login` in a terminal, then Check again.");
      if (dependencies.platform === "win32") {
        const readiness = await rpc.request("windowsSandbox/readiness").catch(() => undefined);
        if (readiness?.status && readiness.status !== SANDBOX_READY) return unhealthy("Run `codex` once in a terminal to set up its sandbox, then Check again.");
      }
      const [models, skills] = await Promise.all([listModels(rpc), listSkills(rpc, workspacePath), recordLimits(rpc)]);
      return {
        agents: [UNSET_CHOICE],
        skills,
        models: [{ id: UNSET_CHOICE, name: "Codex default", provider: "codex" }, ...modelsOf(models)],
        permissionModes: PERMISSION_MODES.map(({ id, name }) => ({ id, name })),
        defaultPermissionMode: DEFAULT_PERMISSION_MODE,
        meters: ["limits"],
        canCompact: true,
        controls: ["followUp"],
        health: { ok: true, detail: `found codex ${version.join(".")}, ${signInDetail(accountState?.account)}` },
      };
    } catch (error) {
      return unhealthy(`The codex command at ${located.path} did not run: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const choicesOf = (scope: Pick<RunScope, "workspacePath" | "model" | "permissionMode" | "systemNote" | "contextNote">) => ({
    workspacePath: scope.workspacePath,
    model: scope.model,
    permissionMode: scope.permissionMode,
    systemNote: scope.systemNote,
    contextNote: scope.contextNote,
  });

  const openSession: RuntimeSteps<LooseNative, CodexHandle>["openSession"] = async (plan, scope) => {
    const { rpc } = await connect();
    const { method, params } = threadOpenRequest(plan, choicesOf(scope));
    try {
      const result = await rpc.request(method, params);
      const threadId = String(result?.thread?.id ?? "");
      if (!threadId) throw new Error(`codex answered ${method} without a thread`);
      return { threadId, threads: new Set([threadId]), workspacePath: scope.workspacePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (plan.spine && THREAD_GONE_PATTERN.test(message)) throw new RecoverableError(SESSION_GONE_MESSAGE, "assemble");
      throw error;
    }
  };

  const skillsOf = (scope: RunScope): SkillRef[] => {
    const known = skillPaths.get(scope.workspacePath);
    return (scope.skills ?? []).flatMap((name) => {
      const path = known?.get(name);
      return path ? [{ name, path }] : [];
    });
  };

  const execute = createStreamRuntime<CodexHandle, CodexRunState, { route: RunRoute }>({
    limits: dependencies.limits,
    temporaryDirectory: tmpdir(),
    begin: (scope, push) => {
      const route: RunRoute = { scope, push };
      routes.add(route);
      return { route, dispose: () => void routes.delete(route) };
    },
    createState: createCodexState,
    translate: (line, state) => {
      try {
        return translateCodexMessage(JSON.parse(line), state);
      } catch (error) {
        log.debug("codex", `Ignored a line that could not be translated: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    },
    open: async (handle, input, scope, { session }) => {
      const { rpc } = await connect();
      session.route.threads = handle.threads;
      let hasEnded = false;
      const subscription = rpc.lines((message) => {
        if (message.method === "turn/completed" && message.params?.threadId === handle.threadId) hasEnded = true;
        return isRunMessage(message, handle.threads);
      });
      try {
        const started = await rpc.request("turn/start", turnStartParams(handle.threadId, input, scope.files, scope.effort, skillsOf(scope)));
        handle.turnId = typeof started?.turn?.id === "string" ? started.turn.id : undefined;
      } catch (error) {
        subscription.close();
        throw error;
      }
      log.info("codex", `Started turn ${handle.turnId} on thread ${handle.threadId} for node ${scope.nodeId}`);
      scope.setRuntimeRef({ sessionId: handle.threadId, lastMessageId: handle.turnId });
      return {
        lines: subscription.lines,
        kill: () => {
          subscription.close();
          if (hasEnded || !handle.turnId) return;
          hasEnded = true;
          rpc.request("turn/interrupt", { threadId: handle.threadId, turnId: handle.turnId }).catch((error) => log.warn("codex", `Could not interrupt turn ${handle.turnId}`, error));
        },
        endFailure: async () => ({ type: "failure", message: describeExit(await rpc.exit), recovery: "report" }),
      };
    },
  });

  const eventMap: RuntimeSteps<LooseNative, CodexHandle>["eventMap"] = {
    ...streamEventMap,
    ...subagentEventMap(() => eventMap),
    usage: usageEvents,
    done: doneEvents,
    compacted: () => [{ type: "context.compacted" }],
    permission: (native) => approvalOpened({ id: native.requestId, title: native.title, detail: native.detail }),
    question: (native) => questionOpened({ id: native.requestId, questions: native.questions }),
  };

  type TurnOutcome = { text: string; status?: string; error?: unknown };

  const runOneShotTurn = async (rpc: JsonRpcProcess, threadId: string, begin: () => Promise<unknown>, signal?: AbortSignal): Promise<TurnOutcome> => {
    let finish: (outcome: TurnOutcome | Error) => void = () => undefined;
    const ended = new Promise<TurnOutcome>((resolve, reject) => {
      let text = "";
      finish = (outcome) => {
        stop();
        signal?.removeEventListener("abort", aborted);
        clearTimeout(timer);
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };
      const stop = rpc.onNotification((message) => {
        if (message.method === "process/exited") return finish(new Error("The codex command exited before finishing"));
        if (message.params?.threadId !== threadId) return;
        if (message.method === "item/completed" && message.params.item?.type === "agentMessage") text = String(message.params.item.text ?? "");
        if (message.method === "turn/completed") finish({ text, status: message.params.turn?.status, error: message.params.turn?.error });
      });
      const aborted = () => finish(new Error("Text generation was stopped"));
      const timer = setTimeout(() => finish(new Error("codex did not finish in time")), ONE_SHOT_TIMEOUT_MS);
      signal?.addEventListener("abort", aborted, { once: true });
    });
    oneShotTurns++;
    try {
      await begin();
      return await ended;
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      ended.catch(() => undefined);
      throw error;
    } finally {
      oneShotTurns--;
    }
  };

  const titleModel = async (): Promise<string | undefined> => {
    const { executable, rpc } = await connect();
    if (!lightModels.has(executable)) lightModels.set(executable, (await listModels(rpc)).map((model) => String(model.id)).find((id) => LIGHT_NAMES.test(id)));
    return lightModels.get(executable);
  };

  const generateText: GenerateText = async (input, purpose, scope, signal) => {
    const { rpc } = await connect();
    const settings = { ...threadSettings({ workspacePath: dependencies.privateDirectory(), model: scope.model, permissionMode: "readOnly" }), approvalPolicy: "never", developerInstructions: ONE_SHOT_SYSTEM_PROMPTS[purpose], ephemeral: true };
    const started = await rpc.request("thread/start", settings);
    const threadId = String(started?.thread?.id ?? "");
    const outcome = await runOneShotTurn(rpc, threadId, () => rpc.request("turn/start", turnStartParams(threadId, input, [])), signal);
    if (outcome.status === "failed") throw new Error(String((outcome.error as any)?.message ?? "codex could not write the text"));
    return outcome.text.trim();
  };

  const dropSession: RuntimeSteps["dropSession"] = async (reference) => {
    const { rpc } = await connect();
    await rpc.request("thread/delete", { threadId: reference.sessionId }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (THREAD_GONE_PATTERN.test(message)) return;
      if (THREAD_STILL_FORKED_PATTERN.test(message)) return log.info("codex", `Kept thread ${reference.sessionId} because a fork still references it`);
      throw error;
    });
  };

  const compact: RuntimeSteps["compact"] = async (reference) => {
    const { rpc } = await connect();
    await rpc.request("thread/resume", { threadId: reference.sessionId }).catch(() => undefined);
    const outcome = await runOneShotTurn(rpc, reference.sessionId, () => rpc.request("thread/compact/start", { threadId: reference.sessionId }));
    if (outcome.status === "failed") throw new Error(String((outcome.error as any)?.message ?? "codex could not compact the session"));
  };

  const control: RuntimeSteps<LooseNative, CodexHandle>["control"] = async (handle, liveControl) => {
    if (liveControl.type !== "followUp" || !handle.turnId) throw new Error("The run does not accept that action");
    const { rpc } = await connect();
    await rpc.request("turn/steer", { threadId: handle.threadId, expectedTurnId: handle.turnId, input: [{ type: "text", text: liveControl.text, text_elements: [] }] });
  };

  const diagnostics = async (): Promise<RuntimeDiagnostics> => {
    const located = dependencies.locate();
    if (!located.path) return { executable: located.path };
    try {
      const { rpc } = await connect();
      const accountState = await rpc.request("account/read", {});
      return { executable: located.path, authMethod: accountState?.account?.type, isSignedIn: Boolean(accountState?.account) || accountState?.requiresOpenaiAuth === false };
    } catch {
      return { executable: located.path };
    }
  };

  return {
    id: "codex",
    editsFiles: true,
    canSuggestTitles: true,
    slots: dependencies.limiter,
    forgetCaches,
    titleModel,
    generateText,
    diagnostics,
    catalog,
    openSession,
    execute,
    eventMap,
    dropSession,
    compact,
    control,
    answerRequest: async () => undefined,
  };
};
