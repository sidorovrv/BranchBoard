import type { Catalog, Id, PendingRequest, RunEvent, RuntimeId, RuntimeRef, SessionPlan } from "@branchboard/core";

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
}

export interface NativeEvent {
  type: string;
}

export type EventMap<Native extends NativeEvent> = Record<string, (native: Native, scope: RunScope) => RunEvent[]>;

export interface RuntimeSteps<Native extends NativeEvent = any, Handle = any> {
  id: RuntimeId;
  canSuggestTitles?: boolean;
  titleModel?(scope: RunScope): Promise<string | undefined>;
  generateTitle?(input: string, scope: RunScope, signal: AbortSignal, purpose?: "title" | "summary"): Promise<string>;
  diagnostics?(workspacePath: string): Promise<RuntimeDiagnostics>;
  catalog(workspacePath: string): Promise<Catalog>;
  openSession(plan: SessionPlan, scope: RunScope): Promise<Handle>;
  execute(handle: Handle, input: string, scope: RunScope): AsyncIterable<Native>;
  eventMap: EventMap<Native>;
  answerRequest(request: PendingRequest, answer: string, scope: RunScope | undefined): Promise<void>;
}
