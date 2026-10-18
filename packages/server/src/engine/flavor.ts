import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isApiRuntime, isLocalBaseUrl, runtimeInfo, type ApiRuntimeId } from "@branchboard/core";
import type { ChannelContents } from "../channel";
import { engineVersionOf } from "../channel";
import type { CredentialStore } from "../credentials";
import { log } from "../log";
import { createServerPool, isNotFound, type OpencodeServer, type ServerFlavor, type ServerLaunch, type ServerPool } from "../runtimes/opencodeServer";
import type { EngineInstaller } from "./install";
import { DEFAULT_ENGINE_VERSION } from "./locator";

export const CUSTOM_PROVIDER_ID = "openai-compatible";
export const OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";
export const ENGINE_PROVIDERS: Record<ApiRuntimeId, string[]> = { anthropic: ["anthropic"], openai: ["openai", CUSTOM_PROVIDER_ID] };

const MODELS_TIMEOUT_MS = 5000;
const SCRUBBED_ENVIRONMENT = /(_API_KEY|_API_TOKEN|_AUTH_TOKEN|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY|_SESSION_TOKEN)$|^OPENCODE_(?!SERVER_PASSWORD$|CONFIG_CONTENT$)/i;

export const engineHomeDirectory = (dataDirectory: string): string => join(dataDirectory, "engine-home");

export const homeEnvironment = (home: string, os: NodeJS.Platform = process.platform): Record<string, string> => ({
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"),
  XDG_CACHE_HOME: join(home, "cache"),
  ...(os === "win32" ? { USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") } : {}),
});

export const scrubbedEnvironment = (env: NodeJS.ProcessEnv): Record<string, undefined> =>
  Object.fromEntries(Object.keys(env).filter((name) => SCRUBBED_ENVIRONMENT.test(name)).map((name) => [name, undefined]));

export const isOpenAiHost = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
};

export const integrationOf = (runtimeId: ApiRuntimeId, baseUrl: string): string => (runtimeId === "anthropic" ? "anthropic" : isOpenAiHost(baseUrl) ? "openai" : CUSTOM_PROVIDER_ID);

export const credentialIdsFor = (listed: { data?: { id?: unknown; integrationID?: unknown }[] }, integrationId: string): string[] =>
  (listed.data ?? []).filter((entry) => entry.integrationID === integrationId).map((entry) => String(entry.id));

const KEY_CONNECT_ATTEMPTS = 10;
const KEY_CONNECT_DELAY_MS = 500;

export const connectKeyWhenReady = async (connect: () => Promise<unknown>, delayMs = KEY_CONNECT_DELAY_MS): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await connect();
      return;
    } catch (error) {
      if (!isNotFound(error) || attempt >= KEY_CONNECT_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

export type FetchModelIds = (baseUrl: string, key: string | undefined) => Promise<string[]>;

export const fetchModelIds: FetchModelIds = async (baseUrl, key) => {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS), redirect: "error", credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? []).flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []));
};

export interface ProviderConfig {
  providers: Record<string, unknown>;
}

export const buildProviderConfig = async (credentials: Pick<CredentialStore, "credentialOf">, listModels: FetchModelIds = fetchModelIds): Promise<ProviderConfig> => {
  const providers: Record<string, unknown> = {};
  const anthropic = credentials.credentialOf("anthropic");
  if (anthropic.baseUrl !== runtimeInfo("anthropic").credential!.defaultBaseUrl) providers.anthropic = { settings: { baseURL: anthropic.baseUrl } };
  const openai = credentials.credentialOf("openai");
  if (!isOpenAiHost(openai.baseUrl)) {
    const ids = await listModels(openai.baseUrl, openai.key).catch(() => []);
    providers[CUSTOM_PROVIDER_ID] = {
      name: "OpenAI-compatible",
      package: OPENAI_COMPATIBLE_PACKAGE,
      settings: { baseURL: openai.baseUrl },
      models: Object.fromEntries(ids.map((id) => [id, { name: id }])),
    };
  } else if (openai.baseUrl !== runtimeInfo("openai").credential!.defaultBaseUrl) providers.openai = { settings: { baseURL: openai.baseUrl } };
  return { providers };
};

export interface EngineDependencies {
  dataDirectory: string;
  installer: EngineInstaller;
  channelContents: () => ChannelContents;
  credentials: CredentialStore;
  listModels?: FetchModelIds;
}

const API_RUNTIME_IDS: ApiRuntimeId[] = ["anthropic", "openai"];

export interface EngineHandle {
  pool: ServerPool;
  version: () => string;
}

export const createEngine = ({ dataDirectory, installer, channelContents, credentials, listModels }: EngineDependencies): EngineHandle => {
  const home = engineHomeDirectory(dataDirectory);
  const version = () => engineVersionOf(channelContents(), DEFAULT_ENGINE_VERSION);
  const launchedBaseUrls = new Map<ApiRuntimeId, string>();

  const credentialIdsOf = async (server: OpencodeServer, integrationId: string): Promise<string[]> =>
    credentialIdsFor(await server.pool.callJson(server, home, "/api/credential"), integrationId);

  const syncKey = async (server: OpencodeServer, runtimeId: ApiRuntimeId) => {
    const { key, baseUrl } = credentials.credentialOf(runtimeId);
    const integrationId = integrationOf(runtimeId, baseUrl);
    for (const id of await credentialIdsOf(server, integrationId)) await server.pool.call(server, home, `/api/credential/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (key) await connectKeyWhenReady(() => server.pool.post(server, home, `/api/integration/${integrationId}/connect/key`, { key }));
  };

  const flavor: ServerFlavor = {
    logName: "engine",
    label: "The engine",
    healthPath: "/api/info",
    missingMessage: "The engine is not installed yet.",
    isShared: true,
    secrets: () => credentials.secretValues(),
    launch: async (): Promise<ServerLaunch> => {
      const pinned = version();
      const binary = await installer.ensure(pinned);
      try {
        installer.pruneOtherVersions(pinned);
      } catch (error) {
        log.warn("engine", "Could not remove an older engine version", error);
      }
      mkdirSync(home, { recursive: true });
      const config = await buildProviderConfig(credentials, listModels);
      API_RUNTIME_IDS.forEach((runtimeId) => launchedBaseUrls.set(runtimeId, credentials.credentialOf(runtimeId).baseUrl));
      return { path: binary, args: [], env: { ...scrubbedEnvironment(process.env), ...homeEnvironment(home), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } };
    },
    onReady: async (server) => {
      for (const runtimeId of API_RUNTIME_IDS) await syncKey(server, runtimeId);
    },
  };

  const pool = createServerPool(flavor);

  credentials.onChange((runtimeId) => {
    if (!isApiRuntime(runtimeId) || launchedBaseUrls.size === 0) return;
    const baseUrl = credentials.credentialOf(runtimeId).baseUrl;
    if (launchedBaseUrls.get(runtimeId) !== baseUrl) {
      launchedBaseUrls.clear();
      void pool.stopAll();
      return;
    }
    for (const started of pool.servers.values()) started.then((server) => syncKey(server, runtimeId)).catch((error) => log.warn("engine", `Could not update the ${runtimeId} key in the engine`, error));
  });

  return { pool, version };
};

export const hasLocalAddress = (baseUrl: string): boolean => isLocalBaseUrl(baseUrl);

export const resetEngineHome = (dataDirectory: string) => rmSync(engineHomeDirectory(dataDirectory), { recursive: true, force: true });
