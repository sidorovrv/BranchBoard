import {
  activeRollOf,
  withoutSecretAnswers,
  withPartKeyPrefix,
  answerText,
  ancestorIds,
  boardTokenUsage,
  branchTitle,
  budgetStateOf,
  contextHash,
  DEFAULT_BOARD_TITLE,
  descendantTitlePatches,
  describeContext,
  estimateTokens,
  expandSlashCommand,
  fidelityOf,
  ANSWER_FORMATS_GUIDE,
  hasAutoTitle,
  isInFlight,
  liveNodes,
  makeNode,
  placeNode,
  namingRoleOf,
  attachmentsToSend,
  NODE_MIN_HEIGHT,
  NODE_MIN_WIDTH,
  now,
  isUsageLimitMessage,
  orderedAncestorIds,
  partsOfRoll,
  planSession,
  recoveryOfMessage,
  redactSecrets,
  renderRequest,
  renderTurns,
  satelliteIdsOf,
  summarySource,
  type ApiRuntimeId,
  type Catalog,
  type GraphNode,
  type Id,
  type NodeStatus,
  type RecoveryId,
  type PendingRequest,
  type RedactionContext,
  type RunEvent,
  type RunInfo,
  type RuntimeId,
  type RuntimeRef,
  type SessionPlan,
  type Usage,
} from "@branchboard/core";
import type { AttachmentStore } from "../attachments";
import { RefusedError, type BoardService } from "../boards";
import { snapshotWorkspace } from "../git";
import { log } from "../log";
import type { CostStore } from "../costs";
import { fileHashesAfterRun } from "../revert";
import type { RunLog } from "../runLog";
import type { UsageRecorder } from "../usage";
import { askOnce } from "./askOnce";
import { expandCommandTemplate } from "./commandExpansion";
import { withSlot } from "./limiter";
import { resolveMentions } from "./mentions";
import { createAnswerWaiters } from "./requests";
import { shortName, suggestTitle } from "./titles";
import { RecoverableError, type LiveControl, type RunFile, type RunScope, type RuntimeSteps } from "./types";

interface ActiveRun {
  boardId: Id;
  isStopping: boolean;
  isWaitingForSlot: boolean;
  controller: AbortController;
  scope: RunScope;
  runtime: RuntimeSteps;
  outcome: RunOutcome;
  handle?: unknown;
}

interface RunOutcome {
  stopped: boolean;
  usage?: Usage;
  runtimeRef?: RuntimeRef;
  answerChars: number;
  retryFailure?: string;
  errors: string[];
  firstRecovery?: RecoveryId;
  satellites: Map<string, Id>;
  partKeyPrefix?: string;
}

export type Runtimes = Record<"fake" | "opencode" | "claude", RuntimeSteps> & Partial<Record<ApiRuntimeId | "opencode2" | "codex", RuntimeSteps>>;

const finalStatusOf = (outcome: RunOutcome): NodeStatus => (outcome.errors.length > 0 && !outcome.stopped ? "error" : "done");

const noteFailure = (outcome: RunOutcome, message: string, recovery: RecoveryId | undefined) => {
  if (outcome.errors.length === 0) outcome.firstRecovery = recovery;
  outcome.errors.push(message);
};

export const DEFAULT_SUMMARY_SHARE = 0.6;
export const MAX_RETRY_ATTEMPTS = 5;
const CATALOG_CACHE_MS = 60 * 1000;
const FINISHED_RUNS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FINISHED_RUNS_LIMIT = 40;
const SUMMARY_TIMEOUT_MS = 180 * 1000;
const CHANGED_FILES_TIMEOUT_MS = 15 * 1000;
const MAX_SUMMARY_SOURCE_CHARS = 200000;
const MIN_TURNS_TO_SUMMARISE = 2;

export const summaryInstruction = (source: string): string =>
  [
    "Summarise the conversation below so that someone continuing it needs nothing else.",
    "Keep decisions, facts, names, file paths, identifiers, constraints and open questions. Plain text, at most 400 words. Do not use tools.",
    "Reply with the summary only.",
    "",
    source.slice(-MAX_SUMMARY_SOURCE_CHARS),
  ].join("\n");

export const createRunService = (
  boards: BoardService,
  runtimes: Runtimes,
  attachments: AttachmentStore,
  runLog: RunLog,
  costs?: CostStore,
  usage?: UsageRecorder,
  redaction: () => RedactionContext = () => ({}),
) => {
  const activeRuns = new Map<Id, ActiveRun>();

  const recordFailure = (boardId: Id, nodeId: Id, outcome: RunOutcome, rawMessage: string, recovery = recoveryOfMessage(rawMessage)) => {
    const message = redactSecrets(rawMessage, redaction());
    noteFailure(outcome, message, recovery);
    boards.recordRunEvent(boardId, nodeId, { type: "error", message, recovery });
  };
  const waiters = createAnswerWaiters();
  const catalogCache = new Map<string, { at: number; catalog: Promise<Catalog | undefined> }>();
  const resumingNodeIds = new Set<Id>();
  const answeringRequestIds = new Set<Id>();

  const runtimeOf = (runtimeId: RuntimeId): RuntimeSteps => {
    const runtime = runtimes[runtimeId];
    if (!runtime) throw new RefusedError(`The ${runtimeId} runtime is not available`);
    return runtime;
  };

  const catalogOf = (runtimeId: RuntimeId, workspacePath: string, isFresh = false): Promise<Catalog | undefined> => {
    const key = `${runtimeId}|${workspacePath}`;
    const cached = catalogCache.get(key);
    if (cached && !isFresh && now() - cached.at < CATALOG_CACHE_MS) return cached.catalog;
    const catalog = runtimeOf(runtimeId).catalog(workspacePath).then(
      (result) => result,
      (error) => {
        log.warn("run", `Could not read the ${runtimeId} catalog`, error);
        if (catalogCache.get(key)?.catalog === catalog) catalogCache.delete(key);
        return undefined;
      },
    );
    catalogCache.set(key, { at: now(), catalog });
    return catalog;
  };

  const patchNode = (boardId: Id, nodeId: Id, fields: Record<string, unknown>) =>
    boards.commitRunPatch(boardId, { type: "patch", patch: { nodes: { [nodeId]: { id: nodeId, ...fields } }, edges: {} } });

  const ownerOf = (boardId: Id, nodeId: Id): Id => boards.stateOf(boardId).graph.nodes[nodeId]?.satelliteOf ?? nodeId;

  const openRequestsOf = (boardId: Id, nodeId: Id) => {
    const related = new Set([nodeId, ...satelliteIdsOf(boards.stateOf(boardId).graph, nodeId)]);
    return boards.openRequests(boardId).filter((request) => related.has(request.nodeId));
  };

  const syncStatus = (boardId: Id, nodeId: Id) => {
    if (!activeRuns.has(nodeId)) return;
    const status: NodeStatus = openRequestsOf(boardId, nodeId).length > 0 ? "awaiting_approval" : "running";
    if (boards.stateOf(boardId).graph.nodes[nodeId].status !== status) patchNode(boardId, nodeId, { status });
  };

  const openRequest = (boardId: Id, nodeId: Id, event: Extract<RunEvent, { type: "request.opened" }>) => {
    const request: PendingRequest = { ...event.request, boardId, nodeId, status: "open", createdAt: now() };
    boards.saveRequest(request);
    syncStatus(boardId, ownerOf(boardId, nodeId));
  };

  const finishSatellite = (boardId: Id, satelliteId: Id, status: NodeStatus) => {
    const satellite = boards.stateOf(boardId).graph.nodes[satelliteId];
    if (!satellite || satellite.status !== "running") return;
    boards.flushParts(boardId, satelliteId);
    patchNode(boardId, satelliteId, { status, completedAt: now() });
  };

  const cleanSubagentTitle = (title: string): string => title.replace(/\s*\(@[\w.-]+ subagent\)\s*$/i, "").trim() || "Subagent";

  const startSatellite = (boardId: Id, parentId: Id, event: Extract<RunEvent, { type: "subagent.started" }>, outcome: RunOutcome) => {
    if (outcome.satellites.has(event.key)) return;
    const { graph } = boards.stateOf(boardId);
    const size = { w: NODE_MIN_WIDTH, h: NODE_MIN_HEIGHT };
    const satellite = makeNode(boardId, {
      kind: "subagent",
      title: cleanSubagentTitle(event.title),
      agent: event.agent,
      status: "running",
      prompt: event.prompt ?? "",
      satelliteOf: parentId,
      ...size,
      startedAt: now(),
      ...placeNode(graph, [parentId], size),
    });
    boards.commitRunPatch(boardId, { type: "addNode", node: satellite, parentIds: [] });
    boards.recordRunEvent(boardId, parentId, { type: "tool.started", partKey: event.partKey, tool: "Subagent", description: satellite.title, subagentId: satellite.id });
    outcome.satellites.set(event.key, satellite.id);
  };

  const routeSatelliteEvent = (boardId: Id, event: Extract<RunEvent, { type: "subagent.event" }>, outcome: RunOutcome) => {
    const satelliteId = outcome.satellites.get(event.key);
    const inner = event.event;
    if (!satelliteId || inner.type === "subagent.started" || inner.type === "subagent.event" || inner.type === "usage") return;
    if (inner.type === "request.opened") return openRequest(boardId, satelliteId, inner);
    if (inner.type === "prompt") return patchNode(boardId, satelliteId, { prompt: inner.text });
    if (inner.type === "done") return finishSatellite(boardId, satelliteId, "done");
    boards.recordRunEvent(boardId, satelliteId, inner);
    if (inner.type === "error") finishSatellite(boardId, satelliteId, "error");
  };

  const finishOpenSatellites = (boardId: Id, outcome: RunOutcome, status: NodeStatus) =>
    outcome.satellites.forEach((satelliteId) => finishSatellite(boardId, satelliteId, status));

  const closeOpenRequests = (boardId: Id, nodeId: Id, answer: string) =>
    openRequestsOf(boardId, nodeId).forEach((request) => {
      waiters.resolve(request.id, answer);
      boards.saveRequest({ ...request, status: "closed", answer });
    });

  const handleEvent = (boardId: Id, nodeId: Id, event: RunEvent, outcome: RunOutcome) => {
    if (event.type === "request.opened") return openRequest(boardId, nodeId, event);
    if (event.type === "subagent.started") return startSatellite(boardId, nodeId, event, outcome);
    if (event.type === "subagent.event") return routeSatelliteEvent(boardId, event, outcome);
    if (event.type === "retry" && event.attempt > MAX_RETRY_ATTEMPTS && !outcome.retryFailure) {
      outcome.retryFailure = event.reason;
      activeRuns.get(nodeId)?.controller.abort();
    }
    if (event.type === "context.compacted") patchNode(boardId, nodeId, { compactedAt: now() });
    if (event.type === "usage") {
      outcome.usage = event.usage;
      trackCost(boardId, nodeId, event.usage);
    }
    if (event.type === "done") outcome.stopped = event.stopped ?? false;
    if (event.type === "error") return recordFailure(boardId, nodeId, outcome, event.message, event.recovery);
    if (event.type === "part.delta" && event.partType === "text") outcome.answerChars += event.text.length;
    boards.recordRunEvent(boardId, nodeId, event);
  };

  const resolveContext = (boardId: Id, nodeId: Id) => {
    const { graph, parts } = boards.stateOf(boardId);
    const plan: SessionPlan = planSession(graph, parts, nodeId);
    return { plan, hash: contextHash(graph, nodeId), contextNodeIds: orderedAncestorIds(graph, nodeId) };
  };

  const streamRun = (runtime: RuntimeSteps, plan: SessionPlan, input: string, scope: RunScope, outcome: RunOutcome) =>
    withSlot(runtime.slots, scope.signal, scope.setWaitingForSlot, async () => {
      const handle = await runtime.openSession(plan, scope);
      const active = activeRuns.get(scope.nodeId);
      if (active) active.handle = handle;
      log.debug("run", `Session opened for node ${scope.nodeId}`);
      const tally: Record<string, number> = {};
      for await (const native of runtime.execute(handle, input, scope)) {
        const events = runtime.eventMap[native.type]?.(native, scope) ?? [];
        events.forEach((event) => {
          tally[event.type] = (tally[event.type] ?? 0) + 1;
          handleEvent(scope.boardId, scope.nodeId, outcome.partKeyPrefix ? withPartKeyPrefix(event, outcome.partKeyPrefix) : event, outcome);
        });
      }
      log.info("run", `Node ${scope.nodeId} stream ended: events ${JSON.stringify(tally)}, answer text ${outcome.answerChars} chars`);
      if (outcome.answerChars === 0 && !scope.signal.aborted) log.warn("run", `Node ${scope.nodeId} finished without any answer text`);
    });

  const persistRun = (boardId: Id, nodeId: Id, status: NodeStatus, outcome: RunOutcome) => {
    const node = boards.stateOf(boardId).graph.nodes[nodeId];
    boards.flushParts(boardId, nodeId);
    patchNode(boardId, nodeId, {
      status,
      stopped: outcome.stopped,
      usage: outcome.usage,
      runtimeRef: outcome.runtimeRef,
      completedAt: now(),
      rev: node.rev + 1,
    });
  };

  const applyTitle = (boardId: Id, nodeId: Id, title: string) => {
    const { graph } = boards.stateOf(boardId);
    const nodes = { [nodeId]: { id: nodeId, title }, ...descendantTitlePatches(graph, nodeId, title) };
    boards.commitRunPatch(boardId, { type: "patch", patch: { nodes, edges: {} } });
  };

  const nameNode = async (boardId: Id, nodeId: Id, runtime: RuntimeSteps) => {
    const { graph, board } = boards.stateOf(boardId);
    const node = graph.nodes[nodeId];
    if (!node || node.deleted) return;
    const role = namingRoleOf(graph, nodeId);
    const needsNodeTitle = runtime.canSuggestTitles === true && role !== undefined && hasAutoTitle(node);
    const needsBoardTitle = role === "new" && board.title === DEFAULT_BOARD_TITLE;
    if (!needsNodeTitle && !needsBoardTitle) return;
    const automaticTitle = node.title;
    const askModel = async (): Promise<string | undefined> => {
      try {
        const suggestion = await suggestTitle({
          runtime,
          scope: { boardId, nodeId, workspacePath: board.workspacePath, agent: node.agent, model: node.model },
          prompt: node.prompt,
          subject: needsBoardTitle && !needsNodeTitle ? "board" : "chat",
        });
        runLog.append({ event: "title", boardId, nodeId, roll: activeRollOf(node), input: suggestion.input, output: suggestion.output, title: suggestion.title });
        return suggestion.title;
      } catch (error) {
        runLog.append({ event: "title", boardId, nodeId, roll: activeRollOf(node), error: error instanceof Error ? error.message : String(error) });
        if (error instanceof DOMException && error.name === "AbortError") log.warn("run", `Naming node ${nodeId} timed out or was stopped`);
        else log.warn("run", `Could not name node ${nodeId}`, error);
        return undefined;
      }
    };
    const name = runtime.canSuggestTitles ? await askModel() : undefined;
    const current = boards.stateOf(boardId);
    const currentNode = current.graph.nodes[nodeId];
    if (name && needsNodeTitle && currentNode && !currentNode.deleted && currentNode.title === automaticTitle)
      applyTitle(boardId, nodeId, role === "branch" ? branchTitle(current.graph, nodeId, name) : name);
    const boardName = name ?? shortName(node.prompt);
    if (needsBoardTitle && boardName && current.board.title === DEFAULT_BOARD_TITLE) {
      boards.saveBoard({ ...current.board, title: boardName });
      boards.announceBoard(boardId);
    }
  };

  const summarise = async (boardId: Id, nodeId: Id) => {
    const state = boards.stateOf(boardId);
    const node = state.graph.nodes[nodeId];
    if (!node || node.deleted || node.kind !== "turn" || node.status !== "done") throw new RefusedError("Only a finished chat can be summarised");
    const { text, coveredNodeIds } = summarySource(state.graph, state.parts, nodeId);
    const hash = contextHash(state.graph, nodeId);
    const rev = node.rev;
    const output = (await askOnce({
      runtime: runtimeOf(state.board.mode),
      scope: { boardId, nodeId, workspacePath: state.board.workspacePath, agent: node.agent, model: node.model },
      input: summaryInstruction(text),
      purpose: "summary",
      timeoutMs: SUMMARY_TIMEOUT_MS,
    })).trim();
    if (!output) throw new RefusedError("The model returned an empty summary");
    const current = boards.stateOf(boardId).graph.nodes[nodeId];
    if (!current || current.deleted || current.rev !== rev) throw new RefusedError("The node changed while it was being summarised");
    boards.commitRunPatch(boardId, { type: "setSummary", nodeId, summary: { text: output, coveredNodeIds, contextHash: hash, rev, model: node.model, tokens: estimateTokens(output) } });
    runLog.append({ event: "summary", boardId, nodeId, roll: activeRollOf(node), coveredNodeIds, input: summaryInstruction(text), output });
  };

  const compact = async (boardId: Id, nodeId: Id) => {
    const state = boards.stateOf(boardId);
    const node = state.graph.nodes[nodeId];
    const runtime = runtimeOf(state.board.mode);
    if (!node || node.deleted || node.kind !== "turn" || node.status !== "done" || !node.runtimeRef) throw new RefusedError("Only a finished chat with a saved session can be compacted");
    if (!runtime.compact) throw new RefusedError(`The ${state.board.mode} runtime cannot compact a session`);
    if (isInFlight(node) || [...satelliteIdsOf(state.graph, nodeId)].some((id) => isInFlight(state.graph.nodes[id]))) throw new RefusedError("The node is running");
    await runtime.compact(node.runtimeRef, state.board.workspacePath);
    patchNode(boardId, nodeId, { compactedAt: now() });
  };

  const control = async (boardId: Id, nodeId: Id, liveControl: LiveControl) => {
    const active = activeRuns.get(nodeId);
    if (!active || active.boardId !== boardId || active.handle === undefined || !active.runtime.control) throw new RefusedError("The run does not accept that action");
    await active.runtime.control(active.handle, liveControl);
    if (liveControl.type === "followUp") handleEvent(boardId, nodeId, { type: "part.delta", partKey: `followup:${now()}`, partType: "text", text: `\n\n**Follow-up:** ${liveControl.text}\n\n` }, active.outcome);
  };

  const summaryCandidateFor =(boardId: Id, nodeId: Id): Id | undefined => {
    const { graph, parts } = boards.stateOf(boardId);
    const plan = planSession(graph, parts, nodeId);
    const missing = new Set(plan.missingTurns.map((turn) => turn.nodeId));
    const covers = (id: Id) => [id, ...ancestorIds(graph, id)];
    return plan.missingTurns
      .filter((turn) => turn.kind === "turn" && graph.nodes[turn.nodeId].status === "done")
      .map((turn) => ({ id: turn.nodeId, covered: covers(turn.nodeId) }))
      .filter((candidate) => candidate.covered.length >= MIN_TURNS_TO_SUMMARISE && candidate.covered.every((id) => missing.has(id)))
      .sort((left, right) => right.covered.length - left.covered.length)[0]?.id;
  };

  const summariseIfContextIsLarge = async (boardId: Id, nodeId: Id, catalog: Catalog | undefined) => {
    const { board, graph, parts } = boards.stateOf(boardId);
    const share = board.summaryShare ?? DEFAULT_SUMMARY_SHARE;
    const node = graph.nodes[nodeId];
    const windowSize = catalog?.models.find((model) => model.id === node.model)?.contextWindow;
    if (share <= 0 || !windowSize) return;
    if (describeContext(graph, parts, nodeId).republished <= share * windowSize) return;
    const candidateId = summaryCandidateFor(boardId, nodeId);
    if (!candidateId) return;
    log.info("run", `Context of node ${nodeId} is over ${Math.round(share * 100)}% of the window, summarising ${candidateId} first`);
    await summarise(boardId, candidateId).catch((error) => log.warn("run", `Automatic summary of ${candidateId} failed`, error));
  };

  interface PreparedRun {
    plan: SessionPlan;
    hash: string;
    contextNodeIds: Id[];
    context: string;
    request: string;
    input: string;
    commandName?: string;
  }

  const prepareRun = async (boardId: Id, nodeId: Id, scope: RunScope): Promise<PreparedRun> => {
    const state = boards.stateOf(boardId);
    const node = state.graph.nodes[nodeId];
    const catalog = await catalogOf(state.board.mode, state.board.workspacePath);
    await summariseIfContextIsLarge(boardId, nodeId, catalog);
    const expanded = expandSlashCommand(node.prompt, catalog?.commands);
    if (expanded.command && !expanded.command.passThrough) expanded.text = await expandCommandTemplate(node.prompt, expanded.command, state.board.workspacePath);
    const mentions = resolveMentions(node.prompt, state.board.workspacePath, { agents: catalog?.agents ?? [], subagents: catalog?.subagents, skills: catalog?.skills?.map((skill) => skill.id) });
    scope.subagents = mentions.subagents;
    scope.skills = mentions.skills;
    const { plan, hash, contextNodeIds } = resolveContext(boardId, nodeId);
    const attachmentFiles: RunFile[] = attachmentsToSend(plan, node).map((item) => ({ name: item.name, mime: item.mime, path: attachments.pathOf(item.id) }));
    scope.files = [...attachmentFiles, ...mentions.files];
    scope.agent = mentions.agent ?? node.agent;
    const context = renderTurns(plan.missingTurns);
    const isShellPrompt = catalog?.shellPrompts === true && node.prompt.trimStart().startsWith("!");
    const isSentAlone = expanded.command?.passThrough === true || isShellPrompt;
    const request = isSentAlone ? expanded.text.trim() : renderRequest(expanded.text, node.quoteText);
    scope.contextNote = isSentAlone && context ? context : undefined;
    return { plan, hash, contextNodeIds, context, request, input: scope.contextNote || !context ? request : `${context}\n\n${request}`, commandName: expanded.command?.name };
  };

  const CONTINUE_REQUEST = "Continue where you stopped.";

  const prepareContinuation = (node: GraphNode, scope: RunScope): PreparedRun => {
    scope.files = [];
    scope.agent = node.agent;
    const plan: SessionPlan = { spine: { nodeId: node.id, runtimeRef: node.runtimeRef! }, missingTurns: [] };
    return { plan, hash: node.contextHash ?? "", contextNodeIds: node.contextNodeIds ?? [], context: "", request: CONTINUE_REQUEST, input: CONTINUE_REQUEST };
  };

  const failAfterRetries = (boardId: Id, nodeId: Id, outcome: RunOutcome) => {
    if (outcome.errors.length > 0) return;
    recordFailure(boardId, nodeId, outcome, `Gave up after ${MAX_RETRY_ATTEMPTS} attempts: ${outcome.retryFailure}`);
  };

  const tagSession = (runtime: RuntimeSteps, scope: RunScope, outcome: RunOutcome) => {
    if (!outcome.runtimeRef || !runtime.tagSession) return;
    const nodeTitle = boards.stateOf(scope.boardId).graph.nodes[scope.nodeId]?.title ?? "";
    void runtime
      .tagSession(outcome.runtimeRef, { boardId: scope.boardId, nodeId: scope.nodeId, nodeTitle }, scope.workspacePath)
      .catch((error) => log.warn("run", `Could not tag the session of node ${scope.nodeId}`, error));
  };

  const executeRun = async (boardId: Id, nodeId: Id) => {
    const state = boards.stateOf(boardId);
    const node = state.graph.nodes[nodeId];
    const isResuming = resumingNodeIds.delete(nodeId);
    if (!node || node.deleted || node.status !== "queued") return;
    const runtime = runtimeOf(state.board.mode);
    const controller = new AbortController();
    const outcome: RunOutcome = { stopped: false, answerChars: 0, errors: [], satellites: new Map(), runtimeRef: isResuming ? node.runtimeRef : undefined, partKeyPrefix: isResuming ? `resume${now()}:` : undefined };
    const roll = activeRollOf(node);
    const scope: RunScope = {
      boardId,
      nodeId,
      workspacePath: state.board.workspacePath,
      agent: node.agent,
      model: node.model,
      effort: node.effort,
      permissionMode: node.permissionMode,
      systemNote: state.board.answerFormatsGuide === false ? undefined : ANSWER_FORMATS_GUIDE,
      environment: state.board.environment,
      files: [],
      signal: controller.signal,
      setRuntimeRef: (reference) => (outcome.runtimeRef = reference),
      setWaitingForSlot: (isWaiting) => {
        const active = activeRuns.get(nodeId);
        if (active) active.isWaitingForSlot = isWaiting;
      },
      waitForAnswer: waiters.wait,
    };
    const started = now();
    let status: NodeStatus = "done";
    log.info("run", `Starting node ${nodeId} on board ${boardId} (runtime=${state.board.mode}, agent=${node.agent}, model=${node.model}, workspace=${scope.workspacePath})`);
    try {
      activeRuns.set(nodeId, { boardId, isStopping: false, isWaitingForSlot: false, controller, scope, runtime, outcome });
      patchNode(boardId, nodeId, { status: "running", stopped: false, usage: undefined, startedAt: started, completedAt: undefined, workspaceSnapshot: null, fileHashes: null, reverted: null });
      const prepared = isResuming ? prepareContinuation(node, scope) : await prepareRun(boardId, nodeId, scope);
      const { plan, hash, contextNodeIds, input } = prepared;
      if (!isResuming) patchNode(boardId, nodeId, { contextHash: hash, contextNodeIds, contextMode: fidelityOf(plan), compactedAt: plan.spine?.compactedAt ?? null });
      runLog.append({
        event: "start",
        boardId,
        nodeId,
        roll,
        runtime: state.board.mode,
        agent: scope.agent,
        model: node.model,
        effort: node.effort,
        permissionMode: node.permissionMode,
        workspace: scope.workspacePath,
        contextMode: fidelityOf(plan),
        contextNodeIds,
        forkedFrom: plan.spine && { nodeId: plan.spine.nodeId, ...plan.spine.runtimeRef },
        resentNodeIds: plan.missingTurns.map((turn) => turn.nodeId),
        files: scope.files.map((file) => ({ name: file.name, mime: file.mime })),
        command: prepared.commandName,
        prompt: node.prompt,
        input,
      });
      const snapshot = controller.signal.aborted || !runtime.editsFiles ? undefined : await snapshotWorkspace(scope.workspacePath);
      if (snapshot) patchNode(boardId, nodeId, { workspaceSnapshot: snapshot });
      if (!controller.signal.aborted) await streamRun(runtime, plan, input, scope, outcome);
      tagSession(runtime, scope, outcome);
      if (controller.signal.aborted && !outcome.retryFailure) outcome.stopped = true;
      if (outcome.retryFailure) failAfterRetries(boardId, nodeId, outcome);
      if (finalStatusOf(outcome) === "error") status = "error";
    } catch (error) {
      if (outcome.retryFailure) {
        failAfterRetries(boardId, nodeId, outcome);
        status = "error";
      } else if (controller.signal.aborted) outcome.stopped = true;
      else {
        status = "error";
        log.error("run", `Node ${nodeId} failed`, error);
        const message = error instanceof Error ? error.message : String(error);
        recordFailure(boardId, nodeId, outcome, message, error instanceof RecoverableError ? error.recovery : undefined);
      }
    } finally {
      try {
        recordCost(boardId, nodeId, outcome);
        closeOpenRequests(boardId, nodeId, "reject");
        finishOpenSatellites(boardId, outcome, status === "error" ? "error" : "done");
        await recordFileHashes(boardId, nodeId, roll, scope.workspacePath, runtime, outcome.runtimeRef);
        activeRuns.delete(nodeId);
        runLog.append({ event: "end", boardId, nodeId, roll, status, stopped: outcome.stopped, durationMs: now() - started, answerChars: outcome.answerChars, errors: outcome.errors, usage: outcome.usage, runtimeRef: outcome.runtimeRef });
        persistRun(boardId, nodeId, status, outcome);
        usage?.record({
          type: "run",
          boardId,
          outcome: status === "error" ? "error" : "done",
          stopped: outcome.stopped,
          runtime: state.board.mode,
          contextMode: boards.stateOf(boardId).graph.nodes[nodeId]?.contextMode,
          recovery: outcome.firstRecovery,
          isRegeneration: roll > 1,
        });
        log.info("run", `Node ${nodeId} finished as ${status}${outcome.stopped ? " (stopped)" : ""} in ${now() - started}ms`);
        flagUsageLimit(boardId, status, outcome);
        flagUnseenResult(boardId, outcome.stopped);
      } catch (error) {
        activeRuns.delete(nodeId);
        log.error("run", `Node ${nodeId} ended but its result could not be recorded`, error);
        try {
          patchNode(boardId, nodeId, { status: "error", completedAt: now() });
        } catch (patchError) {
          log.error("run", `Node ${nodeId} could not be marked as failed`, patchError);
        }
      }
      pump(boardId);
    }
  };

  const changedFilesWithin = (listing: Promise<string[]>): Promise<string[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<string[]>((resolve) => {
      timer = setTimeout(() => resolve([]), CHANGED_FILES_TIMEOUT_MS);
    });
    return Promise.race([listing.catch(() => []), timedOut]).finally(() => clearTimeout(timer));
  };

  const recordFileHashes = async (boardId: Id, nodeId: Id, roll: number, workspacePath: string, runtime: RuntimeSteps, runtimeRef: RuntimeRef | undefined) => {
    try {
      const changed = runtimeRef && runtime.changedFiles ? await changedFilesWithin(runtime.changedFiles(runtimeRef, workspacePath)) : [];
      const fileHashes = fileHashesAfterRun(workspacePath, partsOfRoll(boards.stateOf(boardId).parts[nodeId], roll), changed);
      if (Object.keys(fileHashes).length > 0) patchNode(boardId, nodeId, { fileHashes });
    } catch (error) {
      log.warn("run", `Could not record the file state after node ${nodeId}`, error);
    }
  };

  const costEntryOf = (boardId: Id, nodeId: Id, usage: Usage | undefined) =>
    usage?.costUsd === undefined ? undefined : { at: now(), boardId, nodeId, costUsd: usage.costUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };

  const trackCost = (boardId: Id, nodeId: Id, usage: Usage) => {
    const entry = costEntryOf(boardId, nodeId, usage);
    if (costs && entry) costs.track(entry);
  };

  const recordCost = (boardId: Id, nodeId: Id, outcome: RunOutcome) => {
    const entry = costEntryOf(boardId, nodeId, outcome.usage);
    if (!costs) return;
    if (entry) costs.record(entry);
    else costs.release(nodeId);
  };

  const flagUsageLimit = (boardId: Id, status: NodeStatus, outcome: RunOutcome) => {
    const { board } = boards.stateOf(boardId);
    const hitLimit = status === "error" && outcome.errors.some(isUsageLimitMessage);
    const hasRecovered = status === "done" && !outcome.stopped;
    if ((!hitLimit && !hasRecovered) || Boolean(board.hitUsageLimit) === hitLimit) return;
    boards.saveBoard({ ...board, hitUsageLimit: hitLimit });
    boards.announceBoard(boardId);
  };

  const flagUnseenResult = (boardId: Id, wasStopped: boolean) => {
    const { board, graph } = boards.stateOf(boardId);
    const isBoardBusy = liveNodes(graph).some((node) => isInFlight(node) || node.status === "queued");
    if (wasStopped || isBoardBusy || board.hasUnseenResult) return;
    boards.saveBoard({ ...board, hasUnseenResult: true });
    boards.announceBoard(boardId);
  };

  const pump = (boardId: Id) => {
    const queuedIds = liveNodes(boards.stateOf(boardId).graph)
      .filter((node) => node.status === "queued")
      .map((node) => node.id);
    for (const nodeId of queuedIds) {
      const { graph } = boards.stateOf(boardId);
      const isWaitingOnAncestor = [...ancestorIds(graph, nodeId)].some((id) => isInFlight(graph.nodes[id]));
      if (!isWaitingOnAncestor) void executeRun(boardId, nodeId).catch((error) => log.error("run", `Run failure for node ${nodeId}`, error));
    }
  };

  const refuseIfOverBudget = (boardId: Id) => {
    const { board, graph } = boards.stateOf(boardId);
    if (budgetStateOf(boardTokenUsage(graph), board.budgetTokens) === "exhausted")
      throw new RefusedError(`This board used its budget of ${board.budgetTokens} tokens. Raise it in Settings → Boards → Token budget to keep running`);
  };

  const enqueue = (boardId: Id, nodeId: Id) => {
    refuseIfOverBudget(boardId);
    boards.commitRunPatch(boardId, { type: "queue", nodeId });
    boards.dropHistoryOf(boardId, nodeId);
    resumingNodeIds.delete(nodeId);
    void nameNode(boardId, nodeId, runtimeOf(boards.stateOf(boardId).board.mode)).catch((error) => log.warn("run", `Naming failure for node ${nodeId}`, error));
    pump(boardId);
  };

  const resume = (boardId: Id, nodeId: Id) => {
    refuseIfOverBudget(boardId);
    boards.commitRunPatch(boardId, { type: "resume", nodeId });
    boards.dropHistoryOf(boardId, nodeId);
    resumingNodeIds.add(nodeId);
    pump(boardId);
  };

  const abort = (boardId: Id, nodeId: Id) => {
    const active = activeRuns.get(nodeId);
    if (active) {
      active.isStopping = true;
      active.controller.abort();
      closeOpenRequests(boardId, nodeId, "reject");
      return;
    }
    const node = boards.stateOf(boardId).graph.nodes[nodeId];
    if (node?.status === "queued") {
      resumingNodeIds.delete(nodeId);
      patchNode(boardId, nodeId, { status: "idle" });
      pump(boardId);
    } else if (node && node.kind !== "subagent" && isInFlight(node)) {
      closeOpenRequests(boardId, nodeId, "reject");
      patchNode(boardId, nodeId, { status: "interrupted" });
    }
  };

  const closeOtherApprovals = (boardId: Id, ownerId: Id, answered: PendingRequest) =>
    openRequestsOf(boardId, ownerId)
      .filter((other) => other.kind === "approval" && other.id !== answered.id)
      .forEach((other) => {
        waiters.resolve(other.id, "reject");
        boards.saveRequest({ ...other, status: "closed", answer: "reject" });
      });

  const answerRequest = async (boardId: Id, requestId: Id, answer: string, message?: string) => {
    const request = boards.stateOf(boardId).requests[requestId];
    if (!request || request.status !== "open" || answeringRequestIds.has(requestId)) throw new RefusedError("That request is no longer open");
    const storedAnswer = withoutSecretAnswers(request.questions, answer);
    log.info("run", `Answering request ${requestId} with "${storedAnswer}"`);
    const ownerId = ownerOf(boardId, request.nodeId);
    const active = activeRuns.get(ownerId);
    const runtime = active?.runtime ?? runtimeOf(boards.stateOf(boardId).board.mode);
    answeringRequestIds.add(requestId);
    try {
      await runtime.answerRequest(request, answer, active?.scope, message);
      waiters.resolve(requestId, answer);
      boards.saveRequest({ ...request, status: "closed", answer: storedAnswer });
      if (request.kind === "approval" && answer === "always") await closeDuplicateApprovals(boardId, ownerId, request, active?.scope, runtime);
      if (request.kind === "approval" && answer === "reject" && runtime.rejectClosesRun) closeOtherApprovals(boardId, ownerId, request);
      syncStatus(boardId, ownerId);
    } finally {
      answeringRequestIds.delete(requestId);
    }
  };

  const closeDuplicateApprovals = async (boardId: Id, ownerId: Id, answered: PendingRequest, scope: RunScope | undefined, runtime: RuntimeSteps) => {
    const duplicates = openRequestsOf(boardId, ownerId).filter((other) => other.kind === "approval" && other.title === answered.title && other.detail === answered.detail);
    for (const duplicate of duplicates) {
      await runtime.answerRequest(duplicate, "always", scope).catch((error) => log.warn("run", `Could not forward "always" for duplicate request ${duplicate.id}`, error));
      waiters.resolve(duplicate.id, "always");
      boards.saveRequest({ ...duplicate, status: "closed", answer: "always" });
    }
  };

  const projectNames = () => new Map(boards.listProjects().map((project) => [project.id, project.name]));

  const describeRun = (names: Map<Id, string>, boardId: Id, nodeId: Id, status: NodeStatus, isStopping: boolean, isWaitingForSlot = false): RunInfo => {
    const { board, graph } = boards.stateOf(boardId);
    const node = graph.nodes[nodeId];
    return {
      boardId,
      boardTitle: board.title,
      projectName: (board.projectId && names.get(board.projectId)) ?? "",
      nodeId,
      title: node?.title ?? "(removed node)",
      prompt: (node?.prompt ?? "").slice(0, 120),
      status,
      startedAt: node?.startedAt,
      isStopping,
      isWaitingForSlot,
    };
  };

  const listRuns = (): RunInfo[] => {
    const names = projectNames();
    const running = [...activeRuns.entries()].map(([nodeId, run]) => {
      const node = boards.stateOf(run.boardId).graph.nodes[nodeId];
      return describeRun(names, run.boardId, nodeId, node && isInFlight(node) ? node.status : "running", run.isStopping, run.isWaitingForSlot);
    });
    const queued = boards
      .loadedBoardIds()
      .flatMap((boardId) => liveNodes(boards.stateOf(boardId).graph).filter((node) => node.status === "queued" && !activeRuns.has(node.id)).map((node) => describeRun(names, boardId, node.id, "queued", false)));
    return [...running, ...queued];
  };

  const listFinishedRuns = (): RunInfo[] => {
    const names = projectNames();
    const oldest = now() - FINISHED_RUNS_MAX_AGE_MS;
    return boards
      .loadedBoardIds()
      .flatMap((boardId) =>
        liveNodes(boards.stateOf(boardId).graph)
          .filter((node) => node.kind === "turn" && (node.status === "done" || node.status === "error") && node.completedAt !== undefined && node.completedAt > oldest && !activeRuns.has(node.id))
          .map((node) => ({ boardId, node })),
      )
      .sort((first, second) => (second.node.completedAt ?? 0) - (first.node.completedAt ?? 0))
      .slice(0, FINISHED_RUNS_LIMIT)
      .map(({ boardId, node }) => ({ ...describeRun(names, boardId, node.id, node.status, false), completedAt: node.completedAt, isStopped: node.stopped === true }));
  };

  return { enqueue, resume, abort, listRuns, listFinishedRuns, answerRequest, summarise, compact, control, catalogOf, forgetCatalogs: () => catalogCache.clear(), isActive: (nodeId: Id) => activeRuns.has(nodeId) };
};

export type RunService = ReturnType<typeof createRunService>;
