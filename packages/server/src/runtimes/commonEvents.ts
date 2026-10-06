import { parseTodoItems, type PendingRequest, type QuestionSpec, type RunEvent } from "@branchboard/core";
import type { EventMap, NativeEvent } from "../run/types";

export type LooseNative = NativeEvent & Record<string, any>;

export const APPROVAL_OPTIONS = ["once", "always", "reject"];

export const subagentEventMap = (mapOf: () => EventMap<LooseNative>): EventMap<LooseNative> => ({
  "subagent-start": (native) => [{ type: "subagent.started", key: native.key, title: native.title, agent: native.agent, prompt: native.prompt }],
  "subagent-done": (native) => [{ type: "subagent.event", key: native.key, event: { type: "done" } }],
  sub: (native, scope) => (mapOf()[native.inner.type]?.(native.inner, scope) ?? []).map((event): RunEvent => ({ type: "subagent.event", key: native.key, event })),
});

export const streamEventMap: EventMap<LooseNative> = {
  "user-prompt": (native) => [{ type: "prompt", text: native.text }],
  todos: (native) => [{ type: "todos", items: parseTodoItems(native.items) }],
  text: (native) => [{ type: "part.delta", partKey: native.partId, partType: "text", text: native.delta }],
  reasoning: (native) => [{ type: "part.delta", partKey: native.partId, partType: "reasoning", text: native.delta }],
  "tool-start": (native) => [{ type: "tool.started", partKey: native.partId, tool: native.tool, description: native.description, input: native.input }],
  "tool-done": (native) => [{ type: "tool.done", partKey: native.partId, output: native.output, isError: native.isError }],
};

type RequestFields = Omit<PendingRequest, "boardId" | "nodeId" | "status" | "createdAt">;

export const requestOpened = (request: RequestFields): RunEvent[] => [{ type: "request.opened", request }];

export const approvalOpened = (fields: { id: string; title: string; detail?: string; remoteId?: string }): RunEvent[] =>
  requestOpened({ ...fields, kind: "approval", options: APPROVAL_OPTIONS });

export const questionOpened = (fields: { id: string; questions: QuestionSpec[]; remoteId?: string }): RunEvent[] =>
  requestOpened({ id: fields.id, remoteId: fields.remoteId, kind: "question", title: fields.questions.map((entry) => entry.question).join("\n"), options: [], questions: fields.questions });
