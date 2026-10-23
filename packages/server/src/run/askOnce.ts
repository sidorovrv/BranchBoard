import type { RunEvent, RuntimeRef } from "@branchboard/core";
import { withSlot } from "./limiter";
import type { GenerateText, RunScope, RuntimeSteps } from "./types";

export type AskPurpose = "title" | "summary";

export const ONE_SHOT_SYSTEM_PROMPTS: Record<AskPurpose, string> = {
  title: "You write very short titles. Reply with the title only.",
  summary: "You write faithful, compact summaries of conversations. Keep every decision, fact, name and open question. Reply with the summary only.",
};

export interface AskRequest {
  runtime: RuntimeSteps;
  scope: Pick<RunScope, "boardId" | "nodeId" | "workspacePath" | "agent" | "model">;
  input: string;
  purpose: AskPurpose;
  timeoutMs: number;
}

const collectText = (events: RunEvent[]): string =>
  events.map((event) => (event.type === "part.delta" && event.partType === "text" ? event.text : "")).join("");

export const generateThroughSession =
  (runtime: () => RuntimeSteps): GenerateText =>
  async (input, _purpose, scope) => {
    const target = runtime();
    let reference: RuntimeRef | undefined;
    const trackedScope: RunScope = { ...scope, setRuntimeRef: (next) => (reference = next) };
    try {
      const handle = await target.openSession({ missingTurns: [] }, trackedScope);
      const events: RunEvent[] = [];
      for await (const native of target.execute(handle, input, trackedScope)) events.push(...(target.eventMap[native.type]?.(native, trackedScope) ?? []));
      return collectText(events);
    } finally {
      if (reference) await target.dropSession?.(reference, scope.workspacePath).catch(() => undefined);
    }
  };

export const askOnce = async ({ runtime, scope, input, purpose, timeoutMs }: AskRequest): Promise<string> => {
  if (!runtime.generateText) throw new Error(`The ${runtime.id} runtime cannot generate text`);
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
    const cheapModel = purpose === "title" ? await runtime.titleModel?.(throwawayScope).catch(() => undefined) : undefined;
    const scopeForAsk = cheapModel ? { ...throwawayScope, model: cheapModel } : throwawayScope;
    const generate = runtime.generateText;
    const text = await withSlot(runtime.slots, controller.signal, undefined, () => generate(input, purpose, scopeForAsk, controller.signal));
    if (text === undefined || controller.signal.aborted) throw new Error("Text generation was stopped");
    return text;
  } finally {
    clearTimeout(timer);
  }
};
