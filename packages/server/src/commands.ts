import { mkdirSync, readFileSync, statSync } from "node:fs";
import { requireLocalFolder } from "./pathBrowser";
import { join } from "node:path";
import {
  addNodeEdit,
  asNodeClipboard,
  isToolOutputOmitted,
  canResume,
  DEFAULT_BOARD_TITLE,
  fileNameOf,
  hasAutoTitle,
  MAX_EXTRACTED_FILE_BYTES,
  titleForPrompt,
  importBoardDocument,
  isHtmlPath,
  isInFlight,
  isRuntimeId,
  liveNodes,
  isSafeChoice,
  commentClearingEdits,
  commentTargetOf,
  promptWithComment,
  newId,
  now,
  parseEnvironmentText,
  planPaste,
  RUN_CHOICE_DEFAULTS,
  RUN_CHOICE_KEYS,
  rememberedDefaults,
  seedFrom,
  sensitivePathsOf,
  shouldAutoRun,
  type Board,
  type GraphEdit,
  type GraphNode,
  type Id,
  type Project,
  type RuntimeId,
  type SeedCommand,
} from "@branchboard/core";
import type { AttachmentStore } from "./attachments";
import { RefusedError, SensitiveFilesError, type BoardService } from "./boards";
import { PREVIEW_TTL_MS, type CapabilityStore } from "./capabilities";
import type { CredentialStore } from "./credentials";
import { showInFileManager } from "./fileManager";
import { isKnownBranch, NO_CHANGES, readBranches, readChanges, readFileAtBranch } from "./git";
import { log } from "./log";
import { clearLogs } from "./logSources";
import { revertEdits, type RevertCommand } from "./revert";
import { sensitiveMentionsOf } from "./run/mentions";
import type { RunService, Runtimes } from "./run/pipeline";
import type { Telemetry } from "./telemetry";
import type { TrashService } from "./trash";
import type { UsageRecorder } from "./usage";
import { existingWorkspaceFile, isSensitiveWorkspaceFile, workspaceRelativePathOf } from "./workspaceFiles";
import { writeWorkspaceFile } from "./workspaceWrites";

export interface CommandContext {
  attachments: AttachmentStore;
  capabilities: CapabilityStore;
  credentials: CredentialStore;
  dataDirectory: string;
  databasePath: string;
  boards: BoardService;
  runs: RunService;
  runtimes: Runtimes;
  trash: TrashService;
  telemetry: Telemetry;
  usage: UsageRecorder;
}

type Command = { type: string; boardId?: Id } & Record<string, any>;
type Handler = (context: CommandContext, command: Command) => unknown | Promise<unknown>;

const CLIENT_EDIT_TYPES = ["connect", "disconnect", "reattach", "reorderParents", "deleteNodes", "moveNodes", "editNode", "editComments", "collapse", "reopen", "detach", "selectRoll", "pin", "restoreNodes"] as const;

const editHandler: Handler = ({ boards }, { boardId, ...edit }) => {
  boards.commitEdit(boardId!, edit as GraphEdit);
  return { ok: true };
};

const commentHandler: Handler = (context, command) => {
  const { boards } = context;
  const boardId = command.boardId!;
  const target = command.add ? commentTargetOf(boards.stateOf(boardId).graph, command.nodeId) : undefined;
  if (!target) return editHandler(context, command);
  return editHandler(context, { type: "editNode", boardId, nodeId: target.id, fields: { prompt: promptWithComment(target.prompt, command.add) } });
};

const resolveAttachments =({ attachments }: CommandContext, command: Command) =>
  attachments.describeAll(Array.isArray(command.attachmentIds) ? command.attachmentIds.map(String) : []);

const requireConfirmation = (command: Command, flaggedFiles: string[]) => {
  if (flaggedFiles.length > 0 && command.allowSensitive !== true) throw new SensitiveFilesError(flaggedFiles);
};

const requireConfirmationForMentions = ({ boards }: CommandContext, command: Command, prompt: string) =>
  requireConfirmation(command, sensitiveMentionsOf(prompt, boards.stateOf(command.boardId!).board.workspacePath));

const requireConfirmationForAttachments = (command: Command, attachments: { name: string }[]) =>
  requireConfirmation(command, sensitivePathsOf(attachments.map((attachment) => attachment.name)));

const attachHandler: Handler = (context, command) => {
  const attachments = resolveAttachments(context, command);
  requireConfirmationForAttachments(command, attachments);
  return editHandler(context, { type: "attach", boardId: command.boardId, nodeId: command.nodeId, attachments });
};

const seedHandler: Handler = (context, command) => {
  const { boards, runs } = context;
  const boardId = command.boardId!;
  const { board, graph } = boards.stateOf(boardId);
  const attachments = resolveAttachments(context, command);
  requireConfirmationForAttachments(command, attachments);
  const seedCommand: SeedCommand = { ...(command as SeedCommand), attachments };
  const seed = seedFrom[seedCommand.type](graph, seedCommand);
  const willRun = shouldAutoRun(seed, seedCommand);
  if (willRun) requireConfirmationForMentions(context, command, String(command.prompt ?? ""));
  const edit = addNodeEdit(graph, board, seed, seedCommand.position);
  boards.commitEdit(boardId, edit);
  context.usage.record({ type: "nodeCreated", boardId, kind: seedCommand.type });
  commentClearingEdits(graph, seedCommand).forEach((clearing) => boards.commitEdit(boardId, clearing));
  if (willRun) runs.enqueue(boardId, edit.node.id);
  return { nodeId: edit.node.id };
};

const workspaceFileOf = ({ boards }: CommandContext, boardId: Id, requested: unknown): string => {
  const path = existingWorkspaceFile(boards.stateOf(boardId).board.workspacePath, String(requested ?? ""));
  if (!path) throw new RefusedError("That file is not inside this board's workspace");
  return path;
};

const readCodeFile = (context: CommandContext, command: Command) => {
  const boardId = command.boardId!;
  const path = workspaceFileOf(context, boardId, command.path);
  const filePath = workspaceRelativePathOf(context.boards.stateOf(boardId).board.workspacePath, path);
  requireConfirmation(command, sensitivePathsOf([filePath]));
  if (statSync(path).size > MAX_EXTRACTED_FILE_BYTES) throw new RefusedError("That file is too large to extract into a node");
  const content = readFileSync(path, "utf8");
  if (content.includes("\0")) throw new RefusedError("Only text files can be extracted into a code node");
  return { content, filePath };
};

const extractFileHandler: Handler = (context, command) => {
  const boardId = command.boardId!;
  const { content, filePath } = readCodeFile(context, command);
  return seedHandler(context, { type: "code", boardId, originId: command.originId, nearPosition: command.nearPosition, flowDirection: command.flowDirection, prompt: content, filePath });
};

const extractAttachmentHandler: Handler = (context, command) => {
  const boardId = command.boardId!;
  const { attachment, bytes } = context.attachments.read(String(command.attachmentId ?? ""));
  requireConfirmation(command, sensitivePathsOf([attachment.name]));
  if (bytes.byteLength > MAX_EXTRACTED_FILE_BYTES) throw new RefusedError("That file is too large to extract into a node");
  const content = bytes.toString("utf8");
  if (content.includes("\0")) throw new RefusedError("Only text files can be extracted into a code node");
  return seedHandler(context, { type: "code", boardId, originId: command.originId, isOriginLinked: false, nearPosition: command.nearPosition, flowDirection: command.flowDirection, prompt: content, filePath: attachment.name, sourceAttachmentId: attachment.id });
};

const emptyCodeNodeHandler: Handler = (context, command) => seedHandler(context, { type: "code", boardId: command.boardId, originId: command.originId, nearPosition: command.nearPosition, flowDirection: command.flowDirection });

const openFileHandler: Handler = (context, command) => {
  const boardId = command.boardId!;
  const { content, filePath } = readCodeFile(context, command);
  return editHandler(context, { type: "editNode", boardId, nodeId: command.nodeId, fields: { prompt: content, filePath, gitRef: "", title: fileNameOf(filePath) } });
};

const writeCodeFileHandler: Handler = (context, command) => {
  const boardId = command.boardId!;
  const node = gitCodeNodeOf(context, command);
  if (node.gitRef) throw new RefusedError("A file shown from another branch cannot be edited");
  const content = String(command.content ?? "");
  if (Buffer.byteLength(content) > MAX_EXTRACTED_FILE_BYTES) throw new RefusedError("That text is too large to save into the file");
  const workspacePath = context.boards.stateOf(boardId).board.workspacePath;
  const path = workspaceFileOf(context, boardId, node.filePath);
  requireConfirmation(command, isSensitiveWorkspaceFile(workspacePath, node.filePath!, path) ? [node.filePath!] : []);
  writeWorkspaceFile(workspacePath, node.filePath!, content, { allowSensitive: true });
  editHandler(context, { type: "editNode", boardId, nodeId: node.id, fields: { prompt: content } });
  return { ok: true };
};

const openPreviewHandler: Handler = (context, command) => {
  const node = gitCodeNodeOf(context, command);
  if (node.gitRef || !isHtmlPath(node.filePath!)) throw new RefusedError("Only an HTML file from the project folder can be previewed");
  const path = workspaceFileOf(context, command.boardId!, node.filePath);
  if (isSensitiveWorkspaceFile(context.boards.stateOf(command.boardId!).board.workspacePath, node.filePath!, path)) throw new RefusedError("That file is on the sensitive list and is not previewed");
  const secret = context.capabilities.issue("preview", command.boardId!, PREVIEW_TTL_MS);
  return { url: `/preview/${secret}/${node.filePath!.split(/[\\/]/).map(encodeURIComponent).join("/")}` };
};

const setCredentialHandler: Handler = ({ credentials, runtimes, runs }, command) => {
  if (!isRuntimeId(command.runtimeId)) throw new RefusedError("Unknown runtime");
  const key = command.key === null ? null : typeof command.key === "string" ? command.key : undefined;
  const credential = credentials.set(command.runtimeId, key, typeof command.baseUrl === "string" ? command.baseUrl : undefined);
  if (key !== null) runtimes[command.runtimeId]?.setUp?.();
  void runtimes[command.runtimeId]?.forgetCaches?.();
  runs.forgetCatalogs();
  return { credential };
};

const setUpRuntimeHandler: Handler = ({ runtimes, runs }, command) => {
  if (!isRuntimeId(command.runtimeId)) throw new RefusedError("Unknown runtime");
  runtimes[command.runtimeId]?.setUp?.();
  runs.forgetCatalogs();
  return {};
};

const testCredentialHandler: Handler = async ({ runtimes }, command) => {
  const runtime = isRuntimeId(command.runtimeId) ? runtimes[command.runtimeId] : undefined;
  if (!runtime?.testConnection) throw new RefusedError("That runtime has no key to test");
  return runtime.testConnection();
};

const gitInfoHandler: Handler =({ boards }, command) => readBranches(boards.stateOf(command.boardId!).board.workspacePath);

const gitCodeNodeOf = (context: CommandContext, command: Command): GraphNode => {
  const node = context.boards.stateOf(command.boardId!).graph.nodes[String(command.nodeId)];
  if (!node || node.deleted || node.kind !== "code" || !node.filePath || node.sourceAttachmentId) throw new RefusedError("That node is not a code node made from a workspace file");
  return node;
};

const gitChangesHandler: Handler = async (context, command) => {
  const node = gitCodeNodeOf(context, command);
  const workspacePath = context.boards.stateOf(command.boardId!).board.workspacePath;
  const path = existingWorkspaceFile(workspacePath, node.filePath!);
  if (!path) return NO_CHANGES;
  const { current } = await readBranches(workspacePath);
  return readChanges(workspacePath, path, current, node.gitRef || undefined, node.prompt);
};

const selectCodeBranchHandler: Handler = async (context, command) => {
  const node = gitCodeNodeOf(context, command);
  const boardId = command.boardId!;
  const workspacePath = context.boards.stateOf(boardId).board.workspacePath;
  const requested = String(command.ref ?? "");
  const { current } = await readBranches(workspacePath);
  if (requested === "" || requested === current) {
    const { content } = readCodeFile(context, { ...command, path: node.filePath });
    return editHandler(context, { type: "editNode", boardId, nodeId: node.id, fields: { prompt: content, gitRef: "" } });
  }
  if (!(await isKnownBranch(workspacePath, requested))) throw new RefusedError("That branch does not exist in this repository");
  const path = workspaceFileOf(context, boardId, node.filePath);
  let content: string;
  try {
    content = await readFileAtBranch(workspacePath, path, requested);
  } catch {
    throw new RefusedError(`${node.filePath} does not exist on ${requested}`);
  }
  if (content.length > MAX_EXTRACTED_FILE_BYTES || content.includes("\0")) throw new RefusedError("That version of the file is too large or not text");
  return editHandler(context, { type: "editNode", boardId, nodeId: node.id, fields: { prompt: content, gitRef: requested } });
};

const revealFileHandler: Handler = (context, command) => {
  showInFileManager(workspaceFileOf(context, command.boardId!, command.path));
  return { ok: true };
};

const runHandler: Handler = (context, command) => {
  const { boards, runs } = context;
  const boardId = command.boardId!;
  const nodeId = command.nodeId as Id;
  const current = boards.stateOf(boardId).graph.nodes[nodeId];
  requireConfirmationForMentions(context, command, typeof command.prompt === "string" ? command.prompt : (current?.prompt ?? ""));
  const fields: Record<string, unknown> = Object.fromEntries(["prompt", ...RUN_CHOICE_KEYS].filter((key) => command[key] !== undefined).map((key) => [key, command[key]]));
  if (current && typeof fields.prompt === "string" && hasAutoTitle(current)) fields.title = titleForPrompt(current, fields.prompt);
  if (Object.keys(fields).length > 0) boards.commitEdit(boardId, { type: "editNode", nodeId, fields });
  runs.enqueue(boardId, nodeId);
  rememberChoice(boards, boardId, nodeId);
  return { ok: true };
};

const rememberChoice = (boards: BoardService, boardId: Id, nodeId: Id) => {
  const { board, graph } = boards.stateOf(boardId);
  boards.saveBoard({ ...board, ...rememberedDefaults(graph.nodes[nodeId], board) });
};

const connectProject = async ({ boards, runtimes }: CommandContext, workspacePath: string, mode: RuntimeId, name?: string, chosenModel?: unknown): Promise<Project> => {
  const runtime = runtimes[mode];
  if (!runtime) throw new RefusedError(`Unknown runtime ${mode}`);
  requireLocalFolder(workspacePath);
  const existing = boards.listProjects().find((project) => project.workspacePath === workspacePath && project.mode === mode);
  if (existing) return existing;
  const catalog = await runtime.catalog(workspacePath);
  log.info("project", `Catalog for ${workspacePath} via ${mode}: health=${catalog.health.ok} (${catalog.health.detail}), ${catalog.agents.length} agents, ${catalog.models.length} models`);
  if (!catalog.health.ok) throw new RefusedError(catalog.health.detail);
  return boards.findOrCreateProject({ workspacePath, mode, name, defaultAgent: catalog.agents[0], defaultModel: isSafeChoice(chosenModel) ? chosenModel : catalog.models[0]?.id });
};

const createProjectHandler: Handler = (context, command) => connectProject(context, command.workspacePath, command.mode as RuntimeId, command.name, command.defaultModel);

const renameProjectHandler: Handler = ({ boards }, command) => {
  const project = boards.listProjects().find((candidate) => candidate.id === command.projectId);
  if (!project) throw new RefusedError("Project not found");
  const name = String(command.name ?? "").trim();
  if (!name) throw new RefusedError("A project needs a name");
  const renamed = { ...project, name, updatedAt: now() };
  boards.saveProject(renamed);
  return renamed;
};

const deleteBoardWithRuns = ({ boards, runs }: CommandContext, board: Board, deletedAt: number) => {
  liveNodes(boards.stateOf(board.id).graph)
    .filter(isInFlight)
    .forEach((node) => runs.abort(board.id, node.id));
  boards.saveBoard({ ...boards.stateOf(board.id).board, deleted: true, deletedAt, updatedAt: deletedAt });
};

const deleteProjectHandler: Handler = (context, command) => {
  const { boards } = context;
  const project = boards.listProjects().find((candidate) => candidate.id === command.projectId);
  if (!project) throw new RefusedError("Project not found");
  const deletedAt = now();
  boards.listBoards().filter((board) => board.projectId === project.id).forEach((board) => deleteBoardWithRuns(context, board, deletedAt));
  boards.saveProject({ ...project, deleted: true, deletedAt, updatedAt: deletedAt });
  return { ok: true };
};

const createBoardHandler: Handler = async (context, command) => {
  const { boards } = context;
  const project = command.projectId
    ? boards.listProjects().find((candidate) => candidate.id === command.projectId)
    : await connectProject(context, command.workspacePath, command.mode as RuntimeId);
  if (!project) throw new RefusedError("Project not found");
  const board: Board = {
    id: newId(),
    projectId: project.id,
    title: String(command.title || DEFAULT_BOARD_TITLE),
    workspacePath: project.workspacePath,
    mode: project.mode,
    defaultAgent: command.defaultAgent ?? project.defaultAgent,
    defaultModel: command.defaultModel ?? project.defaultModel,
    createdAt: now(),
    updatedAt: now(),
    deleted: false,
  };
  const created = await boards.createBoard(board);
  context.usage.record({ type: "boardCreated", boardId: board.id });
  return created;
};

const environmentOf = (text: unknown): Record<string, string> | undefined => {
  try {
    const variables = parseEnvironmentText(String(text));
    return Object.keys(variables).length > 0 ? variables : undefined;
  } catch (error) {
    throw new RefusedError(error instanceof Error ? error.message : String(error));
  }
};

const updateBoardHandler: Handler = ({ boards }, command) => {
  const { board } = boards.stateOf(command.boardId!);
  const title = typeof command.title === "string" && command.title.trim() ? { title: command.title.trim() } : {};
  const fields = Object.fromEntries(Object.values(RUN_CHOICE_DEFAULTS).filter((key) => isSafeChoice(command[key])).map((key) => [key, command[key]]));
  const budget = command.budgetTokens === undefined ? {} : { budgetTokens: Number(command.budgetTokens) > 0 ? Math.round(Number(command.budgetTokens)) : undefined };
  const share = command.summaryShare === undefined ? {} : { summaryShare: Math.min(1, Math.max(0, Number(command.summaryShare) || 0)) };
  const guide = command.answerFormatsGuide === undefined ? {} : { answerFormatsGuide: Boolean(command.answerFormatsGuide) };
  const environment = command.environment === undefined ? {} : { environment: environmentOf(command.environment) };
  boards.saveBoard({ ...board, ...title, ...fields, ...budget, ...share, ...guide, ...environment, updatedAt: now() });
  boards.announceBoard(command.boardId!);
  return boards.stateOf(command.boardId!).board;
};

const MAX_PASTED_NODES = 200;
const PASTE_NUDGE = 48;

const storedAttachmentsOf = ({ attachments }: CommandContext, node: GraphNode): GraphNode["attachments"] => {
  const kept = (node.attachments ?? []).flatMap((attachment) => {
    try {
      return [attachments.describeAll([String(attachment.id)])[0]];
    } catch {
      return [];
    }
  });
  return kept.length > 0 ? kept : undefined;
};

const pasteNodesHandler: Handler = (context, command) => {
  const { boards } = context;
  const boardId = command.boardId!;
  const clipboard = asNodeClipboard(command.clipboard);
  if (!clipboard) throw new RefusedError("The clipboard does not hold Branchboard nodes");
  if (clipboard.nodes.length > MAX_PASTED_NODES) throw new RefusedError(`At most ${MAX_PASTED_NODES} nodes can be pasted at once`);
  const sanitised = {
    ...clipboard,
    nodes: clipboard.nodes.map((node) => ({ ...node, attachments: storedAttachmentsOf(context, node) })),
    parts: clipboard.parts.map((part) => (isToolOutputOmitted(part) ? { ...part, meta: { ...part.meta, output: boards.storedToolOutputOf(part) } } : part)),
  };
  const anchor = command.position ?? { x: Math.min(...clipboard.nodes.map((node) => node.x)) + PASTE_NUDGE, y: Math.min(...clipboard.nodes.map((node) => node.y)) + PASTE_NUDGE };
  const plan = planPaste(boards.stateOf(boardId).graph, boardId, sanitised, anchor);
  boards.commitEdit(boardId, { type: "patch", patch: plan.patch });
  plan.replay.forEach(({ nodeId, events }) => events.forEach((event) => boards.recordRunEvent(boardId, nodeId, event)));
  return { nodeIds: plan.nodeIds };
};

const markBoardSeenHandler: Handler = ({ boards }, command) => {
  const { board } = boards.stateOf(command.boardId!);
  if (board.hasUnseenResult || board.hitUsageLimit) {
    boards.saveBoard({ ...board, hasUnseenResult: false, hitUsageLimit: false });
    boards.announceBoard(command.boardId!);
  }
  return { ok: true };
};

const deleteBoardHandler: Handler = (context, command) => {
  deleteBoardWithRuns(context, context.boards.stateOf(command.boardId!).board, now());
  return { ok: true };
};

const importIntoProject = ({ boards, attachments, usage }: CommandContext, project: Project | undefined, raw: string, title?: string): Board => {
  if (!project) throw new RefusedError("Choose a project to import the board into");
  const imported = (() => {
    try {
      return importBoardDocument(raw, "json", title, attachments.restoreDocumentFile);
    } catch (error) {
      throw new RefusedError(`That file cannot be imported: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  const board: Board = {
    id: imported.boardId,
    projectId: project.id,
    title: imported.title,
    workspacePath: project.workspacePath,
    mode: project.mode,
    defaultAgent: project.defaultAgent,
    defaultModel: project.defaultModel,
    createdAt: now(),
    updatedAt: now(),
    deleted: false,
  };
  boards.saveSnapshot({ board, graph: imported.graph, parts: imported.parts });
  usage.record({ type: "boardCreated", boardId: board.id });
  return board;
};

const importBoardHandler: Handler = (context, command) =>
  importIntoProject(context, context.boards.listProjects().find((candidate) => candidate.id === command.projectId), String(command.raw), command.title);

export const commandHandlers: Record<string, Handler> = {
  ...Object.fromEntries(CLIENT_EDIT_TYPES.map((type) => [type, editHandler])),
  editComments: commentHandler,
  undo: ({ boards, usage }, command) => {
    const patch = boards.undo(command.boardId!) ?? null;
    if (patch) usage.record({ type: "undo", boardId: command.boardId! });
    return { patch };
  },
  setTelemetryConsent: ({ telemetry }, command) => (telemetry.setConsent(command.granted === true), { ok: true }),
  redo: ({ boards }, command) => ({ patch: boards.redo(command.boardId!) ?? null }),
  reply: seedHandler,
  sibling: seedHandler,
  note: seedHandler,
  file: seedHandler,
  code: emptyCodeNodeHandler,
  extractFile: extractFileHandler,
  extractAttachment: extractAttachmentHandler,
  openFile: openFileHandler,
  writeCodeFile: writeCodeFileHandler,
  gitInfo: gitInfoHandler,
  gitChanges: gitChangesHandler,
  selectCodeBranch: selectCodeBranchHandler,
  revealFile: revealFileHandler,
  openPreview: openPreviewHandler,
  setCredential: setCredentialHandler,
  testCredential: testCredentialHandler,
  setUpRuntime: setUpRuntimeHandler,
  revertEdits: ({ boards, runs }, command) => revertEdits({ boards, runs }, command as unknown as RevertCommand),
  revealDataFolder: ({ databasePath }) => (showInFileManager(databasePath), { ok: true }),
  clearLogs: ({ dataDirectory }) => ({ cleared: clearLogs(dataDirectory) }),
  attach: attachHandler,
  run: runHandler,
  regenerate: (context, command) => {
    const { boards, runs } = context;
    const boardId = command.boardId!;
    requireConfirmationForMentions(context, command, boards.stateOf(boardId).graph.nodes[command.nodeId]?.prompt ?? "");
    if (command.assemble === true) {
      boards.commitEdit(boardId, { type: "reopen", nodeId: command.nodeId });
      boards.commitEdit(boardId, { type: "editNode", nodeId: command.nodeId, fields: { forceAssemble: true } });
    }
    if (command.continue === true && canResume(boards.stateOf(boardId).graph.nodes[command.nodeId])) runs.resume(boardId, command.nodeId);
    else runs.enqueue(boardId, command.nodeId);
    return { ok: true };
  },
  abort: ({ runs }, command) => (runs.abort(command.boardId!, command.nodeId), { ok: true }),
  answerRequest: async ({ runs }, command) => (await runs.answerRequest(command.boardId!, command.requestId, command.answer, typeof command.message === "string" ? command.message : undefined), { ok: true }),
  saveNow: ({ boards }, command) => boards.saveNow(command.boardId!),
  createProject: createProjectHandler,
  renameProject: renameProjectHandler,
  deleteProject: deleteProjectHandler,
  createBoard: createBoardHandler,
  updateBoard: updateBoardHandler,
  deleteBoard: deleteBoardHandler,
  markBoardSeen: markBoardSeenHandler,
  pasteNodes: pasteNodesHandler,
  restoreProject: ({ trash }, command) => (trash.restoreProject(command.projectId), { ok: true }),
  restoreBoard: ({ trash }, command) => (trash.restoreBoard(command.boardId!), { ok: true }),
  emptyTrash: ({ trash }) => (trash.emptyTrash(), { ok: true }),
  summarise: async ({ runs }, command) => (await runs.summarise(command.boardId!, command.nodeId), { ok: true }),
  compactNode: async ({ runs }, command) => (await runs.compact(command.boardId!, command.nodeId), { ok: true }),
  controlRun: async ({ runs }, command) => {
    const text = typeof command.text === "string" ? command.text.trim() : "";
    if (command.control === "followUp" && text) await runs.control(command.boardId!, command.nodeId, { type: "followUp", text });
    else if (command.control === "background") await runs.control(command.boardId!, command.nodeId, { type: "background" });
    else throw new RefusedError("Unknown run action");
    return { ok: true };
  },
  clearSummary: (context, command) => editHandler(context, { type: "setSummary", boardId: command.boardId, nodeId: command.nodeId }),
  importBoard: importBoardHandler,
};

export const dispatchCommand = async (context: CommandContext, command: Command): Promise<unknown> => {
  if (!Object.hasOwn(commandHandlers, command.type)) throw new RefusedError(`Unknown command ${command.type}`);
  return commandHandlers[command.type](context, command);
};
