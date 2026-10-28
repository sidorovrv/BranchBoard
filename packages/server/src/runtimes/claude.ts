import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, decodeAnswers, isChosen, parseQuestionSpec, REJECTED_ANSWER, SESSION_GONE_MESSAGE, type Catalog, type CatalogCommand, type CatalogModel, type ModelSource } from "@branchboard/core";
import { createDiagnosticsTool, diagnosticsNote, DIAGNOSTICS_TOOL_NAME, type Diagnostics } from "../diagnostics";
import { listWorkspaceCommands, withBundledCommands } from "./claudeCommands";
import { CLAUDE_ALIAS_MODELS, KNOWN_CLAUDE_MODELS, TITLE_MODEL } from "./claudeModels";
import { createLimitsStore, type LimitsStore } from "../limits";
import { log } from "../log";
import { ONE_SHOT_SYSTEM_PROMPTS } from "../run/askOnce";
import { createLimiter, type Limiter } from "../run/limiter";
import { RecoverableError, type GenerateText, type RunScope, type RuntimeDiagnostics, type RuntimeSteps } from "../run/types";
import { ALLOWED_ANSWERS, askApproval, createApprovalMemory, waitForReply, type ApprovalMemory } from "./approvalMemory";
import { createApprovalBroker, type ApprovalBroker, type ApprovalCall, type ApprovalHandler, type ApprovalVerdict } from "./claudeApprovals";
import { locateClaude, CLAUDE_PATH_VARIABLE } from "./claudeLocator";
import {
  approvalDetail,
  supportsSubagentText,
  APPROVAL_SERVER_NAME,
  ASK_USER_QUESTION_TOOL,
  attachmentDirectories,
  buildClaudeArguments,
  buildMcpConfig,
  buildUserMessage,
  createStreamState,
  DEFAULT_CHOICE,
  displayToolName,
  finalEvents,
  linesUntilFollowUpEnds,
  parseStreamLine,
  translateClaudeMessage,
  type StreamState,
} from "./claudeStream";
import { approvalOpened, doneEvents, questionOpened, streamEventMap, subagentEventMap, usageEvents, type LooseNative } from "./commonEvents";
import type { Location } from "./executableLocator";
import { probeClaudeSession, type ClaudeProbe, type SupportedModel } from "./claudeSupportedModels";
import { launchProcess, readOutput, type LaunchProcess, type ProcessExit } from "./spawnProcess";
import { createStreamRuntime } from "./streamRuntime";

export const MAX_CONCURRENT_PROCESSES = 2;
export const TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const PROBE_CACHE_MS = 60_000;

const SESSION_GONE_PATTERN = /no conversation found/i;
const DIAGNOSTICS_PERMISSION_TOOL = `mcp__${APPROVAL_SERVER_NAME}__${DIAGNOSTICS_TOOL_NAME}`;
type TaggedModel = SupportedModel & { source: ModelSource };
const tagged = (models: SupportedModel[], source: ModelSource): TaggedModel[] => models.map((model) => ({ ...model, source }));
const DEFAULT_MODEL = tagged([{ id: DEFAULT_CHOICE, name: "CLI default" }], "builtin");
const ALIAS_MODELS = tagged(CLAUDE_ALIAS_MODELS, "alias");
const MODELS = [...DEFAULT_MODEL, ...ALIAS_MODELS, ...tagged(KNOWN_CLAUDE_MODELS, "builtin")];
const EFFORTS = [DEFAULT_CHOICE, "low", "medium", "high", "xhigh", "max"];
const DEFAULT_PERMISSION_MODE = "acceptEdits";
const PERMISSION_MODES = [
  { id: "manual", name: "Manual" },
  { id: "plan", name: "Plan" },
  { id: "acceptEdits", name: "Accept edits" },
  { id: "auto", name: "Auto" },
  { id: "dontAsk", name: "Don't ask" },
];

const oneShotArguments = (systemPrompt: string) => ["-p", "--output-format", "text", "--model", TITLE_MODEL, "--tools", "", "--system-prompt", systemPrompt, "--no-session-persistence", "--max-turns", "1"];
export const TITLE_ARGUMENTS = oneShotArguments(ONE_SHOT_SYSTEM_PROMPTS.title);
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
  probeSession: (executable: string, workspacePath: string) => Promise<ClaudeProbe>;
  extraModels: () => (SupportedModel & { source?: ModelSource })[];
  noteModelSeen: (modelId: string) => void;
  diagnostics?: Diagnostics;
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

const askQuestions = async (scope: RunScope, push: (native: LooseNative) => void, call: ApprovalCall): Promise<ApprovalVerdict> => {
  const questions = (Array.isArray(call.input.questions) ? call.input.questions : []).map(parseQuestionSpec);
  if (questions.length === 0) return deny("The question tool was called without any questions");
  const requestId = newId();
  const reply = waitForReply(scope, requestId);
  push({ type: "question", requestId, questions });
  const raw = await reply;
  if (raw === REJECTED_ANSWER) return deny("The user dismissed the question without answering");
  const grid = decodeAnswers(questions.length, raw);
  const answers = Object.fromEntries(questions.map((question, index) => [question.question, (grid[index] ?? []).join(", ")]));
  return allow(call, { answers });
};

const createApprovalHandler = (scope: RunScope, push: (native: LooseNative) => void, memory: ApprovalMemory, diagnostics?: Diagnostics): ApprovalHandler => async (call) => {
  if (call.toolName === ASK_USER_QUESTION_TOOL) return askQuestions(scope, push, call);
  if (call.toolName === DIAGNOSTICS_PERMISSION_TOOL && diagnostics?.isAgentAccessOn()) return allow(call);
  const detail = approvalDetail(call.toolName, call.input);
  const answer = await askApproval(scope, push, memory, { tool: call.toolName, memoryDetail: call.toolName === "Bash" ? detail : "", title: `Allow ${displayToolName(call.toolName)}?`, detail });
  return ALLOWED_ANSWERS.includes(answer) ? allow(call) : deny("The user rejected this tool call");
};

const describeExit = (exit: ProcessExit): string => {
  if (SESSION_GONE_PATTERN.test(exit.stderrTail)) return SESSION_GONE_MESSAGE;
  const detail = exit.stderrTail ? `: ${exit.stderrTail}` : "";
  return `The claude command exited with code ${exit.code} before finishing${detail}`;
};

const exitFailure = (exit: ProcessExit): LooseNative => ({ type: "failure", message: describeExit(exit), recovery: SESSION_GONE_PATTERN.test(exit.stderrTail) ? "assemble" : "report" });

type ClaudeRunState = StreamState & { reportedModel?: string };

const translateLine = (noteModelSeen: (modelId: string) => void) => (line: string, state: ClaudeRunState): LooseNative[] => {
  const message = parseStreamLine(line);
  if (message === undefined) {
    log.debug("claude", `Ignored non-JSON output line: ${line.slice(0, 200)}`);
    return [];
  }
  const natives = translateClaudeMessage(message, state);
  if (state.model && state.model !== state.reportedModel) noteModelSeen((state.reportedModel = state.model));
  return natives;
};

export const createClaudeRuntime = (overrides: Pick<ClaudeDependencies, "serverUrl"> & Partial<ClaudeDependencies>): RuntimeSteps<LooseNative, ClaudeHandle> => {
  const dependencies: ClaudeDependencies = {
    approvals: createApprovalBroker(),
    limits: createLimitsStore().of("claude"),
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
    probeSession: (executable, workspacePath) => probeClaudeSession(dependencies.launch, executable, workspacePath, dependencies.environment()),
    extraModels: () => [],
    noteModelSeen: () => undefined,
    ...overrides,
  };
  const approvalMemory = createApprovalMemory();
  const probes = new Map<string, { probe: Promise<ClaudeProbe>; at: number }>();

  const probeOf = (executable: string, workspacePath: string): Promise<ClaudeProbe> => {
    const key = `${executable}|${workspacePath}`;
    const cached = probes.get(key);
    if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.probe;
    const probe = dependencies.probeSession(executable, workspacePath).catch((error): ClaudeProbe => {
      log.debug("claude", `Could not read the model and command lists from claude: ${error instanceof Error ? error.message : String(error)}`);
      return { models: [], commands: [] };
    });
    const entry = { probe, at: Date.now() };
    probes.set(key, entry);
    void probe.then((probed) => {
      if (probed.models.length === 0 && probes.get(key) === entry) probes.delete(key);
    });
    return probe;
  };

  const modelsOf = (supported: SupportedModel[]): CatalogModel[] => {
    const base = supported.length > 0 ? [...DEFAULT_MODEL, ...tagged(supported, "cli"), ...ALIAS_MODELS] : MODELS;
    const known = new Set<string>();
    const extras = dependencies.extraModels().map((model) => ({ ...model, source: model.source ?? "channel" }));
    const unique = [...base, ...extras].filter((model) => !known.has(model.id) && known.add(model.id));
    return unique.map((model) => ({ ...model, provider: "claude", efforts: model.efforts ? [DEFAULT_CHOICE, ...model.efforts] : EFFORTS }));
  };

  const catalog = async (workspacePath: string): Promise<Catalog> => {
    const agents = [DEFAULT_CHOICE, ...dependencies.listAgents(workspacePath)];
    const located = dependencies.locate();
    if (!located.path) return { agents: [], models: [], health: { ok: false, detail: `The claude command was not found. Install it, sign in once by running claude yourself, or set ${CLAUDE_PATH_VARIABLE} to its full path.` } };
    try {
      const version = await dependencies.probeVersion(located.path, workspacePath);
      const probe = await probeOf(located.path, workspacePath);
      const models = modelsOf(probe.models);
      return { agents, models, meters: ["limits"], permissionModes: PERMISSION_MODES, commands: withBundledCommands(dependencies.listCommands(workspacePath), probe.commands), defaultPermissionMode: DEFAULT_PERMISSION_MODE, health: { ok: true, detail: `found claude ${version}` } };
    } catch (error) {
      return { agents: [], models: [], health: { ok: false, detail: `The claude command at ${located.path} did not run: ${error instanceof Error ? error.message : String(error)}` } };
    }
  };

  const subagentTextSupport = new Map<string, Promise<boolean>>();

  const supportsForwardedSubagentText = (executable: string, workspacePath: string): Promise<boolean> => {
    const known = subagentTextSupport.get(executable);
    if (known) return known;
    const probed = dependencies.probeVersion(executable, workspacePath).then(supportsSubagentText, () => {
      subagentTextSupport.delete(executable);
      return false;
    });
    subagentTextSupport.set(executable, probed);
    return probed;
  };

  const openSession = async (plan: { spine?: { runtimeRef: { sessionId: string } } }, scope: RunScope): Promise<ClaudeHandle> => {
    const located = dependencies.locate();
    if (!located.path) throw new RecoverableError(`The claude command was not found. Install it or set ${CLAUDE_PATH_VARIABLE} to its full path.`, "setup");
    const forwardSubagentText = await supportsForwardedSubagentText(located.path, scope.workspacePath);
    return { executable: located.path, sessionId: randomUUID(), resumeFrom: plan.spine?.runtimeRef.sessionId, forwardSubagentText };
  };

  const execute = createStreamRuntime<ClaudeHandle, ClaudeRunState, { secret: string }>({
    limits: dependencies.limits,
    temporaryDirectory: dependencies.temporaryDirectory,
    begin: (scope, push) =>
      dependencies.approvals.register(
        createApprovalHandler(scope, push, approvalMemory, dependencies.diagnostics),
        dependencies.diagnostics ? [createDiagnosticsTool(dependencies.diagnostics, { boardId: scope.boardId, nodeId: scope.nodeId })] : [],
      ),
    createState: createStreamState,
    translate: translateLine(dependencies.noteModelSeen),
    finish: (state) => (state.results.length > 0 && !state.isFinished ? finalEvents(state) : []),
    open: (handle, input, scope, { session, state, writeRunFile }) => {
      const configPath = writeRunFile("mcp.json", JSON.stringify(buildMcpConfig(`${dependencies.serverUrl}/mcp/${session.secret}`)));
      const selfNote = dependencies.diagnostics?.isAgentAccessOn() ? diagnosticsNote(dependencies.diagnostics.version) : undefined;
      const systemNote = [scope.systemNote, selfNote, scope.contextNote].filter(Boolean).join("\n\n");
      const systemNotePath = systemNote ? writeRunFile("system.md", systemNote) : undefined;
      const args = buildClaudeArguments({ ...handle, model: scope.model, agent: scope.agent, effort: scope.effort, permissionMode: isChosen(scope.permissionMode) ? scope.permissionMode : DEFAULT_PERMISSION_MODE, mcpConfigPath: configPath, systemNotePath, addDirectories: attachmentDirectories(scope.files), forwardSubagentText: handle.forwardSubagentText });
      log.info("claude", `Launching ${handle.executable} for node ${scope.nodeId} (${handle.resumeFrom ? `forking ${handle.resumeFrom}` : "new session"} as ${handle.sessionId})`);
      scope.setRuntimeRef({ sessionId: handle.sessionId });
      const userMessage = buildUserMessage(input, scope.files, dependencies.readBase64);
      const running = dependencies.launch(handle.executable, args, { cwd: scope.workspacePath, env: dependencies.environment() });
      running.writeInput(userMessage);
      return { lines: linesUntilFollowUpEnds(running.lines, state), kill: () => running.kill(), endFailure: async () => exitFailure(await running.exit) };
    },
  });

  const eventMap: RuntimeSteps<LooseNative, ClaudeHandle>["eventMap"] = {
    ...streamEventMap,
    ...subagentEventMap(() => eventMap),
    usage: usageEvents,
    done: doneEvents,
    permission: (native) => approvalOpened({ id: native.requestId, title: native.title, detail: native.detail }),
    question: (native) => questionOpened({ id: native.requestId, questions: native.questions }),
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

  const generateText: GenerateText = async (input, purpose, _scope, signal) => {
    const located = dependencies.locate();
    if (!located.path) throw new Error("The claude command was not found");
    for (const flags of TITLE_FLAG_SETS) {
      const { text, exit } = await runTitleProcess(located.path, flags, input, signal, purpose);
      if (exit.code === 0 && text) return text;
      if (!UNKNOWN_OPTION_PATTERN.test(exit.stderrTail)) throw new Error(describeExit(exit));
    }
    throw new Error("This claude version accepts none of the lean title options");
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
    if (!located.path) return { executable: located.path };
    const [supportsSubagentTextFlag, auth] = await Promise.all([
      supportsForwardedSubagentText(located.path, workspacePath),
      dependencies.probeAuth(located.path, workspacePath).then(parseAuthStatus, () => ({})),
    ]);
    return { executable: located.path, supportsSubagentText: supportsSubagentTextFlag, ...auth };
  };

  return { id: "claude", editsFiles: true, canSuggestTitles: dependencies.suggestsTitles, slots: dependencies.limiter, generateText, diagnostics, catalog, forgetCaches: () => (probes.clear(),subagentTextSupport.clear()), openSession, execute, eventMap, answerRequest: async () => undefined };
};
