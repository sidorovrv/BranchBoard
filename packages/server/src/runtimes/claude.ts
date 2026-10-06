import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, decodeAnswers, isChosen, parseQuestionSpec, REJECTED_ANSWER, type Catalog, type CatalogCommand, type RunEvent } from "@branchboard/core";
import { listWorkspaceCommands, withBundledCommands } from "./claudeCommands";
import { createLimitsStore, type LimitsStore } from "../limits";
import { log } from "../log";
import { createChannel } from "../run/channel";
import { createLimiter, type Limiter } from "../run/limiter";
import type { RunScope, RuntimeDiagnostics, RuntimeSteps } from "../run/types";
import { createApprovalBroker, type ApprovalBroker, type ApprovalCall, type ApprovalHandler, type ApprovalVerdict } from "./claudeApprovals";
import { locateClaude, CLAUDE_PATH_VARIABLE } from "./claudeLocator";
import {
  approvalDetail,
  supportsSubagentText,
  ASK_USER_QUESTION_TOOL,
  attachmentDirectories,
  buildClaudeArguments,
  buildMcpConfig,
  buildUserMessage,
  createStreamState,
  DEFAULT_CHOICE,
  displayToolName,
  parseStreamLine,
  translateClaudeMessage,
  type StreamState,
} from "./claudeStream";
import { approvalOpened, questionOpened, streamEventMap, subagentEventMap, type LooseNative } from "./commonEvents";
import type { Location } from "./executableLocator";
import { launchProcess, readOutput, type LaunchProcess, type ProcessExit, type RunningProcess } from "./spawnProcess";

export const MAX_CONCURRENT_PROCESSES = 2;
export const TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const SESSION_GONE_PATTERN = /no conversation found/i;
const ALLOWED_ANSWERS = ["once", "always"];
const MODELS = [
  { id: DEFAULT_CHOICE, name: "CLI default" },
  { id: "sonnet", name: "Sonnet (latest)" },
  { id: "opus", name: "Opus (latest)" },
  { id: "haiku", name: "Haiku (latest)" },
  { id: "claude-opus-5-5", name: "Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
];
const EFFORTS = [DEFAULT_CHOICE, "low", "medium", "high", "xhigh", "max"];
const DEFAULT_PERMISSION_MODE = "acceptEdits";
const PERMISSION_MODES = [
  { id: "manual", name: "Manual" },
  { id: "plan", name: "Plan" },
  { id: "acceptEdits", name: "Accept edits" },
  { id: "auto", name: "Auto" },
  { id: "dontAsk", name: "Don't ask" },
];

export const TITLE_MODEL = "haiku";
const TITLE_SYSTEM_PROMPT = "You write very short titles. Reply with the title only.";
const SUMMARY_SYSTEM_PROMPT = "You write faithful, compact summaries of conversations. Keep every decision, fact, name and open question. Reply with the summary only.";
const ONE_SHOT_SYSTEM_PROMPTS = { title: TITLE_SYSTEM_PROMPT, summary: SUMMARY_SYSTEM_PROMPT };
const oneShotArguments = (systemPrompt: string) => ["-p", "--output-format", "text", "--model", TITLE_MODEL, "--tools", "", "--system-prompt", systemPrompt, "--no-session-persistence", "--max-turns", "1"];
export const TITLE_ARGUMENTS = oneShotArguments(TITLE_SYSTEM_PROMPT);
export const TITLE_FLAG_SETS = [["--safe-mode"], ["--strict-mcp-config", "--disable-slash-commands"]];
const UNKNOWN_OPTION_PATTERN = /unknown option|unrecognized|unexpected argument|invalid option/i;

interface ClaudeHandle {
  executable: string;
  sessionId: string;
  resumeFrom?: string;
  forwardSubagentText?: boolean;
}

export interface ClaudeDependencies {
  approvals: ApprovalBroker;
  limits: LimitsStore;
  serverUrl: string;
  locate: () => Location;
  launch: LaunchProcess;
  probeVersion: (executable: string, workspacePath: string) => Promise<string>;
  limiter: Limiter;
  temporaryDirectory: string;
  readBase64: (path: string) => string;
  listAgents: (workspacePath: string) => string[];
  listCommands: (workspacePath: string) => CatalogCommand[];
  probeAuth: (executable: string, workspacePath: string) => Promise<string>;
  environment: () => NodeJS.ProcessEnv;
  suggestsTitles: boolean;
}

const listWorkspaceAgents = (workspacePath: string): string[] => {
  try {
    return readdirSync(join(workspacePath, ".claude", "agents")).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3));
  } catch {
    return [];
  }
};

const allow = (call: ApprovalCall, extra: Record<string, unknown> = {}): ApprovalVerdict => ({ behavior: "allow", updatedInput: { ...call.input, ...extra } });

const deny = (message: string): ApprovalVerdict => ({ behavior: "deny", message });

const alwaysKey = (workspacePath: string, call: ApprovalCall): string =>
  `${workspacePath}|${call.toolName}|${call.toolName === "Bash" ? approvalDetail(call.toolName, call.input) : ""}`;

const replyOrReject = (scope: RunScope, requestId: string): Promise<string> => {
  const reply = scope.waitForAnswer(requestId);
  if (scope.signal.aborted) return Promise.resolve(REJECTED_ANSWER);
  const aborted = new Promise<string>((resolve) => scope.signal.addEventListener("abort", () => resolve(REJECTED_ANSWER), { once: true }));
  return Promise.race([reply, aborted]);
};

const askQuestions = async (scope: RunScope, push: (native: LooseNative) => void, call: ApprovalCall): Promise<ApprovalVerdict> => {
  const questions = (Array.isArray(call.input.questions) ? call.input.questions : []).map(parseQuestionSpec);
  if (questions.length === 0) return deny("The question tool was called without any questions");
  const requestId = newId();
  const reply = replyOrReject(scope, requestId);
  push({ type: "question", requestId, questions });
  const raw = await reply;
  if (raw === REJECTED_ANSWER) return deny("The user dismissed the question without answering");
  const grid = decodeAnswers(questions.length, raw);
  const answers = Object.fromEntries(questions.map((question, index) => [question.question, (grid[index] ?? []).join(", ")]));
  return allow(call, { answers });
};

const createApprovalHandler = (scope: RunScope, push: (native: LooseNative) => void, alwaysAllowed: Set<string>): ApprovalHandler => async (call) => {
  if (call.toolName === ASK_USER_QUESTION_TOOL) return askQuestions(scope, push, call);
  const key = alwaysKey(scope.workspacePath, call);
  if (alwaysAllowed.has(key)) return allow(call);
  const requestId = newId();
  const reply = replyOrReject(scope, requestId);
  push({ type: "permission", requestId, title: `Allow ${displayToolName(call.toolName)}?`, detail: approvalDetail(call.toolName, call.input) });
  const answer = await reply;
  if (answer === "always") alwaysAllowed.add(key);
  return ALLOWED_ANSWERS.includes(answer) ? allow(call) : deny("The user rejected this tool call");
};

const describeExit = (exit: ProcessExit): string => {
  if (SESSION_GONE_PATTERN.test(exit.stderrTail)) return "Claude no longer has the saved session of the parent node. Use assemble to resend the context as text.";
  const detail = exit.stderrTail ? `: ${exit.stderrTail}` : "";
  return `The claude command exited with code ${exit.code} before finishing${detail}`;
};

const pumpOutput = async (running: RunningProcess, state: StreamState, push: (native: LooseNative) => void, signal: AbortSignal) => {
  for await (const line of running.lines) {
    const message = parseStreamLine(line);
    if (message === undefined) log.debug("claude", `Ignored non-JSON output line: ${line.slice(0, 200)}`);
    else translateClaudeMessage(message, state).forEach(push);
  }
  const exit = await running.exit;
  if (!state.isFinished && !signal.aborted) push({ type: "failure", message: describeExit(exit) });
};

const writeRunFile = (directory: string, fileName: string, content: string): string => {
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const path = join(directory, fileName);
  writeFileSync(path, content, { mode: PRIVATE_FILE_MODE });
  return path;
};

export const createClaudeRuntime = (overrides: Pick<ClaudeDependencies, "serverUrl"> & Partial<ClaudeDependencies>): RuntimeSteps<LooseNative, ClaudeHandle> => {
  const dependencies: ClaudeDependencies = {
    approvals: createApprovalBroker(),
    limits: createLimitsStore(),
    locate: () => locateClaude(),
    launch: launchProcess,
    probeVersion: (executable, workspacePath) => readOutput(executable, ["--version"], { cwd: workspacePath, env: process.env }),
    limiter: createLimiter(MAX_CONCURRENT_PROCESSES),
    temporaryDirectory: join(tmpdir(), "branchboard-claude"),
    readBase64: (path) => readFileSync(path).toString("base64"),
    listAgents: listWorkspaceAgents,
    listCommands: listWorkspaceCommands,
    probeAuth: (executable, workspacePath) => readOutput(executable, ["auth", "status"], { cwd: workspacePath, env: process.env }),
    environment: () => ({ ...process.env, MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_MS), CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(TOOL_TIMEOUT_MS) }),
    suggestsTitles: true,
    ...overrides,
  };
  const alwaysAllowed = new Set<string>();

  const catalog = async (workspacePath: string): Promise<Catalog> => {
    const agents = [DEFAULT_CHOICE, ...dependencies.listAgents(workspacePath)];
    const models = MODELS.map((model) => ({ ...model, provider: "claude", efforts: EFFORTS }));
    const located = dependencies.locate();
    if (!located.path) return { agents: [], models: [], health: { ok: false, detail: `The claude command was not found. Install it, sign in once by running claude yourself, or set ${CLAUDE_PATH_VARIABLE} to its full path.` } };
    try {
      const version = await dependencies.probeVersion(located.path, workspacePath);
      return { agents, models, permissionModes: PERMISSION_MODES, commands: withBundledCommands(dependencies.listCommands(workspacePath)), defaultPermissionMode: DEFAULT_PERMISSION_MODE, health: { ok: true, detail: `found claude ${version}` } };
    } catch (error) {
      return { agents: [], models: [], health: { ok: false, detail: `The claude command at ${located.path} did not run: ${error instanceof Error ? error.message : String(error)}` } };
    }
  };

  const subagentTextSupport = new Map<string, Promise<boolean>>();

  const supportsForwardedSubagentText = (executable: string, workspacePath: string): Promise<boolean> => {
    const known = subagentTextSupport.get(executable);
    if (known) return known;
    const probed = dependencies.probeVersion(executable, workspacePath).then(supportsSubagentText, () => false);
    subagentTextSupport.set(executable, probed);
    return probed;
  };

  const openSession = async (plan: { spine?: { runtimeRef: { sessionId: string } } }, scope: RunScope): Promise<ClaudeHandle> => {
    const located = dependencies.locate();
    if (!located.path) throw new Error(`The claude command was not found. Install it or set ${CLAUDE_PATH_VARIABLE} to its full path.`);
    const forwardSubagentText = await supportsForwardedSubagentText(located.path, scope.workspacePath);
    return { executable: located.path, sessionId: randomUUID(), resumeFrom: plan.spine?.runtimeRef.sessionId, forwardSubagentText };
  };

  async function* execute(handle: ClaudeHandle, input: string, scope: RunScope): AsyncGenerator<LooseNative> {
    if (dependencies.limiter.isFull()) scope.setWaitingForSlot?.(true);
    const release = await dependencies.limiter.acquire(scope.signal);
    scope.setWaitingForSlot?.(false);
    if (!release) return;
    const channel = createChannel<LooseNative>();
    const registration = dependencies.approvals.register(createApprovalHandler(scope, channel.push, alwaysAllowed));
    const runFiles: string[] = [];
    let running: RunningProcess | undefined;
    const stop = () => running?.kill();
    scope.signal.addEventListener("abort", stop, { once: true });
    try {
      if (scope.signal.aborted) return;
      const configPath = writeRunFile(dependencies.temporaryDirectory, `${handle.sessionId}.mcp.json`, JSON.stringify(buildMcpConfig(`${dependencies.serverUrl}/mcp/${registration.secret}`)));
      runFiles.push(configPath);
      const systemNotePath = scope.systemNote ? writeRunFile(dependencies.temporaryDirectory, `${handle.sessionId}.system.md`, scope.systemNote) : undefined;
      if (systemNotePath) runFiles.push(systemNotePath);
      const args = buildClaudeArguments({ ...handle, model: scope.model, agent: scope.agent, effort: scope.effort, permissionMode: isChosen(scope.permissionMode) ? scope.permissionMode : DEFAULT_PERMISSION_MODE, mcpConfigPath: configPath, systemNotePath, addDirectories: attachmentDirectories(scope.files), forwardSubagentText: handle.forwardSubagentText });
      log.info("claude", `Launching ${handle.executable} for node ${scope.nodeId} (${handle.resumeFrom ? `forking ${handle.resumeFrom}` : "new session"} as ${handle.sessionId})`);
      scope.setRuntimeRef({ sessionId: handle.sessionId });
      running = dependencies.launch(handle.executable, args, { cwd: scope.workspacePath, env: dependencies.environment() });
      running.writeInput(buildUserMessage(input, scope.files, dependencies.readBase64));
      running.endInput();
      const state = createStreamState();
      void pumpOutput(running, state, channel.push, scope.signal)
        .catch((error) => channel.push({ type: "failure", message: error instanceof Error ? error.message : String(error) }))
        .finally(channel.close);
      for await (const native of channel.iterator) {
        if (native.type === "session") scope.setRuntimeRef({ sessionId: native.sessionId });
        else if (native.type === "limits") dependencies.limits.record(native.info, { boardId: scope.boardId, nodeId: scope.nodeId });
        else if (native.type === "failure") throw new Error(native.message);
        else yield native;
        if (native.type === "done") return;
      }
    } finally {
      scope.signal.removeEventListener("abort", stop);
      stop();
      registration.dispose();
      runFiles.forEach((path) => rmSync(path, { force: true }));
      release();
    }
  }

  const eventMap: RuntimeSteps<LooseNative, ClaudeHandle>["eventMap"] = {
    ...streamEventMap,
    ...subagentEventMap(() => eventMap),
    usage: (native) => [
      {
        type: "usage",
        usage: {
          inputTokens: native.inputTokens,
          outputTokens: native.outputTokens,
          contextTokens: native.contextTokens,
          contextWindow: native.contextWindow,
          cacheReadTokens: native.cacheReadTokens,
          cacheCreationTokens: native.cacheCreationTokens,
          firstCallCacheReadTokens: native.firstCallCacheReadTokens,
          firstCallCacheCreationTokens: native.firstCallCacheCreationTokens,
        },
      },
    ],
    permission: (native) => approvalOpened({ id: native.requestId, title: native.title, detail: native.detail }),
    question: (native) => questionOpened({ id: native.requestId, questions: native.questions }),
    done: (): RunEvent[] => [{ type: "done" }],
  };

  const runTitleProcess = async (executable: string, flags: string[], input: string, signal: AbortSignal, purpose: "title" | "summary"): Promise<{ text: string; exit: ProcessExit }> => {
    mkdirSync(dependencies.temporaryDirectory, { recursive: true });
    const running = dependencies.launch(executable, [...oneShotArguments(ONE_SHOT_SYSTEM_PROMPTS[purpose]), ...flags], { cwd: dependencies.temporaryDirectory, env: dependencies.environment() });
    const stop = () => running.kill();
    signal.addEventListener("abort", stop, { once: true });
    try {
      running.writeInput(input);
      running.endInput();
      const lines: string[] = [];
      for await (const line of running.lines) lines.push(line);
      return { text: lines.join("\n").trim(), exit: await running.exit };
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
    }
  };

  const generateTitle = async (input: string, _scope: RunScope, signal: AbortSignal, purpose: "title" | "summary" = "title"): Promise<string> => {
    const located = dependencies.locate();
    if (!located.path) throw new Error("The claude command was not found");
    const release = await dependencies.limiter.acquire(signal);
    if (!release) throw new Error("Title generation was stopped");
    try {
      for (const flags of TITLE_FLAG_SETS) {
        const { text, exit } = await runTitleProcess(located.path, flags, input, signal, purpose);
        if (exit.code === 0 && text) return text;
        if (!UNKNOWN_OPTION_PATTERN.test(exit.stderrTail)) throw new Error(describeExit(exit));
      }
      throw new Error("This claude version accepts none of the lean title options");
    } finally {
      release();
    }
  };

  const parseAuthStatus = (raw: string): { authMethod?: string; isSignedIn?: boolean } => {
    try {
      const status = JSON.parse(raw);
      return { authMethod: typeof status.authMethod === "string" ? status.authMethod : undefined, isSignedIn: typeof status.loggedIn === "boolean" ? status.loggedIn : undefined };
    } catch {
      return {};
    }
  };

  const diagnostics = async (workspacePath: string): Promise<RuntimeDiagnostics> => {
    const located = dependencies.locate();
    const processSlots = { active: dependencies.limiter.activeCount(), limit: dependencies.limiter.limit, waiting: dependencies.limiter.waitingCount() };
    if (!located.path) return { executable: located.path, processSlots };
    const [supportsSubagentTextFlag, auth] = await Promise.all([
      supportsForwardedSubagentText(located.path, workspacePath),
      dependencies.probeAuth(located.path, workspacePath).then(parseAuthStatus, () => ({})),
    ]);
    return { executable: located.path, processSlots, supportsSubagentText: supportsSubagentTextFlag, ...auth };
  };

  return { id: "claude", canSuggestTitles: dependencies.suggestsTitles, generateTitle, diagnostics, catalog, openSession, execute, eventMap, answerRequest: async () => undefined };
};
