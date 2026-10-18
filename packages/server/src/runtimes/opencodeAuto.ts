import { forgetOpencodeGeneration, opencodeGeneration } from "./opencodeGeneration";
import { opencode1Runtime, opencodeEventMap } from "./opencode";
import { opencode2Runtime } from "./opencode2";
import { configuredServerAddress, opencodeSlots } from "./opencodeServer";
import type { RuntimeSteps } from "../run/types";

const delegate = async (): Promise<RuntimeSteps> => (configuredServerAddress() || (await opencodeGeneration()) === 2 ? opencode2Runtime : opencode1Runtime);

export const opencodeRuntime: RuntimeSteps = {
  id: "opencode",
  editsFiles: true,
  canSuggestTitles: true,
  slots: opencodeSlots,
  titleModel: async (scope) => (await delegate()).titleModel?.(scope),
  generateText: async (input, purpose, scope, signal) => (await delegate()).generateText!(input, purpose, scope, signal),
  dropSession: async (reference, workspacePath) => (await delegate()).dropSession?.(reference, workspacePath),
  changedFiles: async (reference, workspacePath) => (await delegate()).changedFiles?.(reference, workspacePath) ?? [],
  compact: async (reference, workspacePath) => (await delegate()).compact?.(reference, workspacePath),
  testConnection: async () => (await delegate()).testConnection?.() ?? { ok: false, detail: "This runtime has no connection test" },
  tagSession: async (reference, tags, workspacePath) => (await delegate()).tagSession?.(reference, tags, workspacePath),
  catalog: async (workspacePath) => (await delegate()).catalog(workspacePath),
  diagnostics: async (workspacePath) => (await (await delegate()).diagnostics?.(workspacePath)) ?? {},
  panels: async (workspacePath) => (await (await delegate()).panels?.(workspacePath)) ?? [],
  panelAction: async (panelId, rowId, actionId, workspacePath) => (await delegate()).panelAction?.(panelId, rowId, actionId, workspacePath),
  control: async (handle, control) => (await delegate()).control?.(handle, control),
  forgetCaches: async () => {
    forgetOpencodeGeneration();
    await opencode2Runtime.forgetCaches?.();
  },
  openSession: async (plan, scope) => (await delegate()).openSession(plan, scope),
  execute: async function* (handle, input, scope) {
    yield* (await delegate()).execute(handle, input, scope);
  },
  eventMap: opencodeEventMap,
  answerRequest: async (request, answer, scope, message) => (await delegate()).answerRequest(request, answer, scope, message),
};
