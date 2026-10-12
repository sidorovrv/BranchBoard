import { forgetOpencodeGeneration, opencodeGeneration } from "./opencodeGeneration";
import { opencode1Runtime, opencodeEventMap } from "./opencode";
import { opencode2Runtime } from "./opencode2";
import type { RuntimeSteps } from "../run/types";

const delegate = async (): Promise<RuntimeSteps> => ((await opencodeGeneration()) === 2 ? opencode2Runtime : opencode1Runtime);

export const opencodeRuntime: RuntimeSteps = {
  id: "opencode",
  editsFiles: true,
  canSuggestTitles: true,
  titleModel: async (scope) => (await delegate()).titleModel?.(scope),
  catalog: async (workspacePath) => (await delegate()).catalog(workspacePath),
  diagnostics: async (workspacePath) => (await (await delegate()).diagnostics?.(workspacePath)) ?? {},
  forgetCaches: forgetOpencodeGeneration,
  openSession: async (plan, scope) => (await delegate()).openSession(plan, scope),
  execute: async function* (handle, input, scope) {
    yield* (await delegate()).execute(handle, input, scope);
  },
  eventMap: opencodeEventMap,
  answerRequest: async (request, answer, scope) => (await delegate()).answerRequest(request, answer, scope),
};
