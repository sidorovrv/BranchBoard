import type { CatalogCommand, ChatPart, GitChanges, QuestionSpec, TodoItem } from "./kit/types";
import type { RecoveryId } from "./recovery";
import type { CredentialStatus, RuntimeId } from "./runtimes";

export type Id = string;
export type NodeKind = "turn" | "context" | "file" | "subagent" | "code";
export type NodeStatus = "idle" | "queued" | "running" | "awaiting_approval" | "done" | "error" | "interrupted";
export type ContextMode = "exact" | "injected" | "assembled";
export type { RuntimeId };

export interface RuntimeRef {
  sessionId: string;
  firstMessageId?: string;
  lastMessageId?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  contextTokens?: number;
  contextWindow?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  firstCallCacheReadTokens?: number;
  firstCallCacheCreationTokens?: number;
  costUsd?: number;
}

export interface CostSummary {
  costUsd: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  windowMs: number;
}

export interface Attachment {
  id: Id;
  name: string;
  mime: string;
  size: number;
}

export interface NodeSummary {
  text: string;
  coveredNodeIds: Id[];
  contextHash: string;
  rev: number;
  model?: string;
  tokens: number;
}

export interface RevertedFile {
  path: string;
  afterRun: string | null;
  restoredHash: string | null;
}

export interface RevertRecord {
  at: number;
  files: RevertedFile[];
}

export interface RollSnapshot {
  status: NodeStatus;
  runtimeRef?: RuntimeRef;
  compactedAt?: number | null;
  contextHash?: string;
  contextNodeIds?: Id[];
  contextMode?: ContextMode;
  usage?: Usage;
  stopped?: boolean;
  startedAt?: number;
  completedAt?: number;
  workspaceSnapshot?: string | null;
  fileHashes?: Record<string, string | null> | null;
  reverted?: RevertRecord | null;
}

export interface NodeComment {
  id: Id;
  roll: number;
  start: number;
  end: number;
  quote: string;
  text: string;
}

export interface GraphNode {
  id: Id;
  boardId: Id;
  kind: NodeKind;
  agent?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  status: NodeStatus;
  title: string;
  prompt: string;
  quoteText?: string;
  filePath?: string;
  sourceAttachmentId?: Id;
  gitRef?: string;
  attachments?: Attachment[];
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
  forceAssemble: boolean;
  rev: number;
  runtimeRef?: RuntimeRef;
  compactedAt?: number | null;
  contextHash?: string;
  contextNodeIds?: Id[];
  contextMode?: ContextMode;
  usage?: Usage;
  stopped?: boolean;
  workspaceSnapshot?: string | null;
  fileHashes?: Record<string, string | null> | null;
  reverted?: RevertRecord | null;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  activeRoll?: number;
  rollCount?: number;
  rolls?: Record<number, RollSnapshot>;
  comments?: NodeComment[];
  pinned?: boolean;
  satelliteOf?: Id;
  summary?: NodeSummary;
  deleted: boolean;
  deletedAt?: number;
}

export interface GraphEdge {
  id: Id;
  boardId: Id;
  fromId: Id;
  toId: Id;
  seq: number;
  createdAt: number;
  deleted: boolean;
  deletedAt?: number;
}

export interface BoardGraph {
  nodes: Record<Id, GraphNode>;
  edges: Record<Id, GraphEdge>;
}

export type NodePatch = Partial<GraphNode> & { id: Id };
export type EdgePatch = Partial<GraphEdge> & { id: Id };

export interface Patch {
  nodes: Record<Id, NodePatch>;
  edges: Record<Id, EdgePatch>;
}

export interface Project {
  id: Id;
  name: string;
  workspacePath: string;
  mode: RuntimeId;
  defaultAgent?: string;
  defaultModel?: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  deletedAt?: number;
}

export interface RunInfo {
  boardId: Id;
  boardTitle: string;
  projectName: string;
  nodeId: Id;
  title: string;
  prompt: string;
  status: NodeStatus;
  startedAt?: number;
  completedAt?: number;
  isStopped?: boolean;
  isStopping: boolean;
  isWaitingForSlot?: boolean;
}

export interface TrashedNodeGroup {
  boardId: Id;
  boardTitle: string;
  deletedAt: number;
  nodeIds: Id[];
  titles: string[];
}

export interface TrashListing {
  projects: { id: Id; name: string; deletedAt: number; boardCount: number }[];
  boards: { id: Id; title: string; projectName: string; deletedAt: number }[];
  nodeGroups: TrashedNodeGroup[];
}

export interface Board {
  id: Id;
  projectId?: Id;
  title: string;
  workspacePath: string;
  mode: RuntimeId;
  defaultAgent?: string;
  defaultModel?: string;
  defaultEffort?: string;
  defaultPermissionMode?: string;
  budgetTokens?: number;
  summaryShare?: number;
  answerFormatsGuide?: boolean;
  environment?: Record<string, string>;
  discardedSessions?: RuntimeRef[];
  hasUnseenResult?: boolean;
  hitUsageLimit?: boolean;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  deletedAt?: number;
}

export interface Part extends ChatPart {
  nodeId: Id;
  roll?: number;
}

export interface PendingRequest {
  id: Id;
  boardId: Id;
  nodeId: Id;
  kind: "approval" | "question";
  title: string;
  detail?: string;
  options: string[];
  questions?: QuestionSpec[];
  status: "open" | "closed";
  answer?: string;
  remoteId?: string;
  createdAt: number;
}

export type RunEvent =
  | { type: "part.delta"; partKey: string; partType: "text" | "reasoning"; text: string }
  | { type: "tool.started"; partKey: string; tool: string; description: string; input?: unknown; subagentId?: Id }
  | { type: "tool.done"; partKey: string; output: string; isError?: boolean }
  | { type: "request.opened"; request: Omit<PendingRequest, "boardId" | "nodeId" | "status" | "createdAt"> }
  | { type: "todos"; items: TodoItem[] }
  | { type: "subagent.started"; key: string; partKey: string; title: string; agent?: string; prompt?: string }
  | { type: "prompt"; text: string }
  | { type: "subagent.event"; key: string; event: RunEvent }
  | { type: "usage"; usage: Usage }
  | { type: "retry"; attempt: number; at: number; reason: string }
  | { type: "retry-restart"; partKeys: string[] }
  | { type: "context.compacted" }
  | { type: "error"; message: string; recovery?: RecoveryId }
  | { type: "done"; stopped?: boolean };

export type BoardEvent =
  | { type: "patch"; patch: Patch }
  | { type: "run"; nodeId: Id; event: RunEvent }
  | { type: "request"; request: PendingRequest }
  | { type: "board"; board: Board }
  | { type: "saved"; at: number };

export type TurnKind = NodeKind | "summary";

export interface Turn {
  nodeId: Id;
  kind: TurnKind;
  coveredNodeIds?: Id[];
  title: string;
  input: string;
  output: string;
  attachments: Attachment[];
}

export interface SessionPlan {
  spine?: { nodeId: Id; runtimeRef: RuntimeRef; compactedAt?: number };
  missingTurns: Turn[];
}

export interface BoardView {
  graph: BoardGraph;
  parts: Record<Id, Part[]>;
  requests: Record<Id, PendingRequest>;
  savedAt: number;
}

export type ModelSource = "builtin" | "alias" | "cli" | "channel" | "seen";

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  source?: ModelSource;
  contextWindow?: number;
  efforts?: string[];
}

export interface CatalogPermissionMode {
  id: string;
  name: string;
}

export interface EngineSetup {
  phase: "idle" | "installing" | "failed" | "ready";
  version?: string;
  message?: string;
  cause?: "offline" | "npm-missing" | "disk-full" | "other";
}

export interface CatalogSkill {
  id: string;
  name: string;
  description?: string;
}

export interface PanelAction {
  id: string;
  label: string;
}

export interface PanelRow {
  id: string;
  label: string;
  detail?: string;
  actions?: PanelAction[];
}

export interface RuntimePanel {
  id: string;
  title: string;
  hint?: string;
  empty: string;
  rows: PanelRow[];
}

export type LiveControlId = "followUp" | "background";

export interface Catalog {
  agents: string[];
  subagents?: string[];
  skills?: CatalogSkill[];
  models: CatalogModel[];
  permissionModes?: CatalogPermissionMode[];
  commands?: CatalogCommand[];
  defaultPermissionMode?: string;
  defaultModel?: string;
  defaultAgent?: string;
  meters?: ("cost" | "limits")[];
  canCompact?: boolean;
  controls?: LiveControlId[];
  shellPrompts?: boolean;
  engine?: EngineSetup;
  health: { ok: boolean; detail: string };
  credential?: CredentialStatus;
}

export interface DocumentFile {
  name: string;
  mime: string;
  base64: string;
}

export interface BoardDocument {
  format: "branchboard";
  version: number;
  board: Board;
  nodes: GraphNode[];
  edges: GraphEdge[];
  parts: Part[];
  staleNodeIds: Id[];
  files?: Record<Id, DocumentFile>;
}

export type GraphEdit =
  | { type: "connect"; fromId: Id; toId: Id }
  | { type: "disconnect"; edgeId: Id }
  | { type: "reattach"; edgeId: Id; end: "from" | "to"; nodeId: Id }
  | { type: "reorderParents"; nodeId: Id; edgeIds: Id[] }
  | { type: "addNode"; node: GraphNode; parentIds: Id[] }
  | { type: "deleteNodes"; ids: Id[]; withExclusiveDescendants?: boolean }
  | { type: "moveNodes"; positions: Record<Id, Partial<Pick<GraphNode, "x" | "y" | "w" | "h">>> }
  | { type: "attach"; nodeId: Id; attachments: Attachment[] }
  | { type: "detach"; nodeId: Id; attachmentId: Id }
  | { type: "reopen"; nodeId: Id }
  | { type: "queue"; nodeId: Id }
  | { type: "resume"; nodeId: Id }
  | { type: "selectRoll"; nodeId: Id; roll: number }
  | { type: "editNode"; nodeId: Id; fields: Partial<Pick<GraphNode, "prompt" | "title" | "filePath" | "gitRef" | "agent" | "model" | "effort" | "permissionMode" | "forceAssemble">> }
  | { type: "editComments"; nodeId: Id; add?: NodeComment; update?: { id: Id; text: string }; removeId?: Id; clearRoll?: number }
  | { type: "collapse"; nodeId: Id; collapsed?: boolean }
  | { type: "pin"; nodeId: Id; pinned?: boolean }
  | { type: "restoreNodes"; ids: Id[] }
  | { type: "setSummary"; nodeId: Id; summary?: NodeSummary }
  | { type: "patch"; patch: Patch };

export interface GitBranches {
  isRepo: boolean;
  current?: string;
  branches: string[];
}

