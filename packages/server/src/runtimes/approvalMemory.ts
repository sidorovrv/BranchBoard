import { newId, REJECTED_ANSWER } from "@branchboard/core";
import type { RunScope } from "../run/types";
import type { LooseNative } from "./commonEvents";

export const ALLOWED_ANSWERS = ["once", "always"];

export const waitForReply = (scope: RunScope, requestId: string): Promise<string> => {
  const reply = scope.waitForAnswer(requestId);
  if (scope.signal.aborted) return Promise.resolve(REJECTED_ANSWER);
  let stopWaiting: () => void = () => undefined;
  const aborted = new Promise<string>((resolve) => {
    const onAbort = () => resolve(REJECTED_ANSWER);
    scope.signal.addEventListener("abort", onAbort, { once: true });
    stopWaiting = () => scope.signal.removeEventListener("abort", onAbort);
  });
  return Promise.race([reply, aborted]).finally(stopWaiting);
};

export const createApprovalMemory = () => {
  const allowed = new Set<string>();
  const keyOf = (workspacePath: string, tool: string, detail: string) => `${workspacePath}|${tool}|${detail}`;
  return {
    isAllowed: (workspacePath: string, tool: string, detail = "") => allowed.has(keyOf(workspacePath, tool, detail)),
    remember: (workspacePath: string, tool: string, detail = "") => void allowed.add(keyOf(workspacePath, tool, detail)),
  };
};

export type ApprovalMemory = ReturnType<typeof createApprovalMemory>;

export interface ApprovalAsk {
  tool: string;
  memoryDetail?: string;
  title: string;
  detail?: string;
}

export const askApproval = async (scope: RunScope, push: (native: LooseNative) => void, memory: ApprovalMemory, ask: ApprovalAsk): Promise<string> => {
  if (memory.isAllowed(scope.workspacePath, ask.tool, ask.memoryDetail)) return "always";
  const requestId = newId();
  const reply = waitForReply(scope, requestId);
  push({ type: "permission", requestId, title: ask.title, detail: ask.detail });
  const answer = await reply;
  if (answer === "always") memory.remember(scope.workspacePath, ask.tool, ask.memoryDetail);
  return answer;
};
