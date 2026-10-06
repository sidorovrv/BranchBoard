import type { RunEvent } from "@branchboard/core";
import type { RunScope, RuntimeSteps } from "./types";

export type AskPurpose = "title" | "summary";

export interface AskRequest {
  runtime: RuntimeSteps;
  scope: Pick<RunScope, "boardId" | "nodeId" | "workspacePath" | "agent" | "model">;
  input: string;
  purpose: AskPurpose;
  timeoutMs: number;
}

const collectText = (events: RunEvent[]): string =>
  events.map((event) => (event.type === "part.delta" && event.partType === "text" ? event.text : "")).join("");

export const askOnce = async ({ runtime, scope, input, purpose, timeoutMs }: AskRequest): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const throwawayScope: RunScope = {
    ...scope,
    files: [],
    signal: controller.signal,
    setRuntimeRef: () => undefined,
    waitForAnswer: async () => "reject",
  };
  try {
    if (runtime.generateTitle) return await runtime.generateTitle(input, throwawayScope, controller.signal, purpose);
    const cheapModel = purpose === "title" ? await runtime.titleModel?.(throwawayScope).catch(() => undefined) : undefined;
    const scopeForAsk = cheapModel ? { ...throwawayScope, model: cheapModel } : throwawayScope;
    const handle = await runtime.openSession({ missingTurns: [] }, scopeForAsk);
    const events: RunEvent[] = [];
    for await (const native of runtime.execute(handle, input, scopeForAsk)) events.push(...(runtime.eventMap[native.type]?.(native, scopeForAsk) ?? []));
    return collectText(events);
  } finally {
    clearTimeout(timer);
  }
};
