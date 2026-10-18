import { runtimeInfo, type ApiRuntimeId, type Catalog, type CatalogModel } from "@branchboard/core";
import type { CredentialStore } from "../credentials";
import type { RuntimeSteps } from "../run/types";
import { KNOWN_CLAUDE_MODELS } from "../runtimes/claudeModels";
import { createOpencode2Runtime } from "../runtimes/opencode2";
import type { EngineHandle } from "./flavor";
import { ENGINE_PROVIDERS } from "./flavor";
import type { EngineInstaller, EngineSetupState } from "./install";

export const ENGINE_FALLBACK_MODELS: Record<ApiRuntimeId, CatalogModel[]> = {
  anthropic: KNOWN_CLAUDE_MODELS.map((model) => ({ id: `anthropic/${model.id}`, name: model.name, provider: "anthropic" })),
  openai: [],
};

export interface EngineRuntimeDependencies {
  engine: EngineHandle;
  installer: EngineInstaller;
  credentials: CredentialStore;
}

const engineNotReady = (state: EngineSetupState, fallback: CatalogModel[], credentials: CredentialStore, id: ApiRuntimeId): Catalog => {
  const detailOf = (): string => {
    if (state.phase === "installing") return "Downloading the engine. This happens once.";
    if (state.phase === "failed") return state.message ?? "The engine install failed.";
    return credentials.isReady(id) ? "The engine downloads when you connect." : `No ${runtimeInfo(id).label} key is saved yet.`;
  };
  const isConnectable = state.phase === "idle" && credentials.isReady(id);
  return { agents: [], models: fallback, credential: credentials.status(id), engine: state, health: { ok: isConnectable, detail: detailOf() } };
};

export const engineRuntime = (id: ApiRuntimeId, { engine, installer, credentials }: EngineRuntimeDependencies): RuntimeSteps => {
  const fallbackModels = ENGINE_FALLBACK_MODELS[id];
  const inner = createOpencode2Runtime({ id, pool: engine.pool, providerIds: ENGINE_PROVIDERS[id], fallbackModels, credential: () => credentials.status(id), executable: () => installer.locate(engine.version()) });
  const isInstalled = () => installer.locate(engine.version()) !== undefined;
  const setUp = () => {
    if (!isInstalled() && installer.state().phase !== "installing") void installer.ensure(engine.version()).catch(() => undefined);
  };
  const stateOf = (): EngineSetupState => {
    const state = installer.state();
    return { ...state, version: state.version ?? engine.version() };
  };
  return {
    ...inner,
    setUp,
    catalog: async (workspacePath) => {
      if (!isInstalled()) return engineNotReady(stateOf(), fallbackModels, credentials, id);
      return { ...(await inner.catalog(workspacePath)), engine: stateOf() };
    },
    diagnostics: async (workspacePath) => ({ ...(await inner.diagnostics?.(workspacePath)), engine: stateOf(), isSignedIn: credentials.status(id).saved, authMethod: "API key" }),
    testConnection: async () => {
      if (!credentials.isReady(id)) return { ok: false, detail: `No ${runtimeInfo(id).label} key is saved yet.` };
      if (!isInstalled()) return { ok: false, detail: "The engine is not installed yet." };
      return (await inner.testConnection?.()) ?? { ok: false, detail: "This runtime has no connection test" };
    },
  };
};
