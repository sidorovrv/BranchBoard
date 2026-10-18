import type { Catalog, EngineSetup, Id, PendingRequest, RecoveryId, RunEvent, RuntimeId, RuntimePanel, RuntimeRef, SessionPlan } from "@branchboard/core";
import type { Limiter } from "./limiter";

export interface RunFile {
  name: string;
  mime: string;
  path: string;
}

export interface RunScope {
  boardId: Id;
  nodeId: Id;
  workspacePath: string;
  agent?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  systemNote?: string;
  contextNote?: string;
  environment?: Record<string, string>;
  subagents?: string[];
  skills?: string[];
  files: RunFile[];
  signal: AbortSignal;
  setRuntimeRef(reference: RuntimeRef): void;
  setWaitingForSlot?(isWaiting: boolean): void;
  waitForAnswer(requestId: Id): Promise<string>;
}

export interface RuntimeDiagnostics {
  executable?: string;
  authMethod?: string;
  isSignedIn?: boolean;
  processSlots?: { active: number; limit: number; waiting: number };
  servers?: string[];
  supportsSubagentText?: boolean;
  engine?: EngineSetup;
}

export interface NativeEvent {
  type: string;
}

export type EventMap<Native extends NativeEvent> = Record<string, (native: Native, scope: RunScope) => RunEvent[]>;

export type GenerateText = (input: string, purpose: "title" | "summary", scope: RunScope, signal: AbortSignal) => Promise<string>;

export interface SessionTags {
  boardId: Id;
  nodeId: Id;
  nodeTitle: string;
}

export type LiveControl = { type: "followUp"; text: string } | { type: "background" };

export interface RuntimeSteps<Native extends NativeEvent = any, Handle = any> {
  id: RuntimeId;
  control?(handle: Handle, control: LiveControl): Promise<void>;
  canSuggestTitles?: boolean;
  editsFiles?: boolean;
  rejectClosesRun?: boolean;
  slots?: Limiter;
  panels?(workspacePath: string): Promise<RuntimePanel[]>;
  panelAction?(panelId: string, rowId: string, actionId: string, workspacePath: string): Promise<void>;
  testConnection?(): Promise<{ ok: boolean; detail: string }>;
  setUp?(): void;
  forgetCaches?(): void | Promise<void>;
  titleModel?(scope: RunScope): Promise<string | undefined>;
  generateText?: GenerateText;
  dropSession?(runtimeRef: RuntimeRef, workspacePath: string): Promise<void>;
  changedFiles?(runtimeRef: RuntimeRef, workspacePath: string): Promise<string[]>;
  compact?(runtimeRef: RuntimeRef, workspacePath: string): Promise<void>;
  tagSession?(runtimeRef: RuntimeRef, tags: SessionTags, workspacePath: string): Promise<void>;
  diagnostics?(workspacePath: string): Promise<RuntimeDiagnostics>;
  catalog(workspacePath: string): Promise<Catalog>;
  openSession(plan: SessionPlan, scope: RunScope): Promise<Handle>;
  execute(handle: Handle, input: string, scope: RunScope): AsyncIterable<Native>;
  eventMap: EventMap<Native>;
  answerRequest(request: PendingRequest, answer: string, scope: RunScope | undefined, message?: string): Promise<void>;
}

export class RecoverableError extends Error {
  constructor(
    message: string,
    readonly recovery: RecoveryId,
  ) {
    super(message);
  }
}
