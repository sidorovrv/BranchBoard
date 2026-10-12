import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isChosen, redactSecrets, runtimeInfo, type ApiRuntimeId, type Catalog, type CatalogModel } from "@branchboard/core";
import type { ApiCredential, CredentialStore } from "../credentials";
import { createLimiter, type Limiter } from "../run/limiter";
import { RecoverableError, type RunFile, type RuntimeSteps } from "../run/types";
import { doneEvents, streamEventMap, usageEvents, type LooseNative } from "./commonEvents";
import { sseData } from "./sse";
import { createStreamRuntime } from "./streamRuntime";

export const MAX_CONCURRENT_REQUESTS = 4;
const HEADER_TIMEOUT_MS = 60 * 1000;
const MODELS_TIMEOUT_MS = 10 * 1000;
const MODELS_CACHE_MS = 10 * 60 * 1000;
const MAX_ERROR_CHARS = 4000;
const SHOWN_ERROR_CHARS = 300;
const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface ChatImage {
  mime: string;
  base64: string;
}

export interface ChatInput {
  model: string;
  system?: string;
  text: string;
  images: ChatImage[];
}

export interface ApiRunState {
  isFinished: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  finishReason?: string;
}

export interface ApiProvider {
  id: ApiRuntimeId;
  headers(key: string | undefined): Record<string, string>;
  chatUrl(baseUrl: string): string;
  modelsUrl(baseUrl: string): string;
  chatBody(chat: ChatInput): unknown;
  parseModels(json: unknown): CatalogModel[];
  fallbackModels: CatalogModel[];
  translate(data: string, state: ApiRunState): LooseNative[];
  errorMessageOf(json: any): string | undefined;
}

export interface ApiDependencies {
  credentials: CredentialStore;
  fetchImpl: typeof fetch;
  limiter: Limiter;
  readBase64: (path: string) => string;
}

interface ApiHandle {
  sessionId: string;
  model: string;
}

export const finishNatives = (state: ApiRunState): LooseNative[] => {
  state.isFinished = true;
  return [
    {
      type: "usage",
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      contextTokens: state.inputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheCreationTokens: state.cacheCreationTokens,
    },
    { type: "done" },
  ];
};

export const parseJson = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

const failureText = (error: unknown): string => {
  const reason = (error as { cause?: { message?: string; code?: string } })?.cause;
  const text = `${reason?.message ?? ""} ${(error as Error)?.message ?? ""}`;
  if (/redirect/i.test(text)) return "The server tried to redirect the request. Branchboard does not follow redirects, so your key is never sent to another address.";
  return `Could not reach the server: ${reason?.code ?? reason?.message ?? (error instanceof Error ? error.message : String(error))}`;
};

export const createApiRuntime = (provider: ApiProvider, overrides: Partial<ApiDependencies> & Pick<ApiDependencies, "credentials">): RuntimeSteps<LooseNative, ApiHandle> & { testConnection(): Promise<{ ok: boolean; detail: string }> } => {
  const dependencies: ApiDependencies = {
    fetchImpl: fetch,
    limiter: createLimiter(MAX_CONCURRENT_REQUESTS),
    readBase64: (path) => readFileSync(path).toString("base64"),
    ...overrides,
  };
  const { credentials, fetchImpl } = dependencies;
  const info = runtimeInfo(provider.id);
  const modelsCache = new Map<string, { at: number; models: CatalogModel[] }>();

  const redacted = (text: string): string => redactSecrets(text, { secrets: credentials.secretValues() });

  const requestFailure = async (response: Response): Promise<Error> => {
    const text = (await response.text().catch(() => "")).slice(0, MAX_ERROR_CHARS);
    const detail = redacted(provider.errorMessageOf(parseJson(text)) ?? text.slice(0, SHOWN_ERROR_CHARS));
    if (response.status === 401 || response.status === 403) return new RecoverableError(`${info.label} rejected the API key (${response.status}). ${detail}`.trim(), "setup");
    if (response.status === 429) return new Error(`Rate limit reached (429). ${detail}`.trim());
    return new Error(`${info.label} answered ${response.status}. ${detail}`.trim());
  };

  const send = async (url: string, init: RequestInit & { signal: AbortSignal }, headerTimeoutMs: number): Promise<Response> => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), headerTimeoutMs);
    try {
      return await fetchImpl(url, { ...init, redirect: "error", credentials: "omit", signal: AbortSignal.any([init.signal, timeout.signal]) });
    } catch (error) {
      if (init.signal.aborted) throw error;
      throw new Error(timeout.signal.aborted ? "The server did not answer in time" : redacted(failureText(error)));
    } finally {
      clearTimeout(timer);
    }
  };

  const listModels = async (credential: ApiCredential, isFresh = false): Promise<CatalogModel[]> => {
    const cacheKey = `${credential.baseUrl}|${createHash("sha256").update(credential.key ?? "").digest("hex")}`;
    const cached = modelsCache.get(cacheKey);
    if (cached && !isFresh && Date.now() - cached.at < MODELS_CACHE_MS) return cached.models;
    const response = await send(provider.modelsUrl(credential.baseUrl), { method: "GET", headers: provider.headers(credential.key), signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) }, MODELS_TIMEOUT_MS);
    if (!response.ok) throw await requestFailure(response);
    const models = provider.parseModels(await response.json().catch(() => undefined));
    modelsCache.set(cacheKey, { at: Date.now(), models });
    return models;
  };

  const catalog = async (): Promise<Catalog> => {
    const status = credentials.status(provider.id);
    if (!credentials.isReady(provider.id)) return { agents: [], models: [], credential: status, health: { ok: false, detail: `No ${info.label} key is saved yet.` } };
    try {
      const models = await listModels(credentials.credentialOf(provider.id));
      return { agents: [], models: models.length > 0 ? models : provider.fallbackModels, credential: status, health: { ok: true, detail: `${info.label} is ready (${models.length} models listed)` } };
    } catch (error) {
      if (error instanceof RecoverableError) return { agents: [], models: [], credential: status, health: { ok: false, detail: error.message } };
      return { agents: [], models: provider.fallbackModels, credential: status, health: { ok: true, detail: `${info.label} is ready; the model list could not be read (${error instanceof Error ? error.message : String(error)})` } };
    }
  };

  const testConnection = async () => {
    if (!credentials.isReady(provider.id)) return { ok: false, detail: "Save a key first." };
    try {
      const models = await listModels(credentials.credentialOf(provider.id), true);
      return { ok: true, detail: `Connected. ${models.length} models available.` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  };

  const openSession = async (_plan: unknown, scope: { model?: string }): Promise<ApiHandle> => {
    if (!credentials.isReady(provider.id)) throw new RecoverableError(`No ${info.label} key is saved yet.`, "setup");
    const model = isChosen(scope.model) ? scope.model : (await catalog()).models[0]?.id;
    if (!model) throw new Error("Choose a model for this node first.");
    return { sessionId: randomUUID(), model };
  };

  const imagesOf = (files: RunFile[]): ChatImage[] => files.filter((file) => INLINE_IMAGE_TYPES.includes(file.mime)).map((file) => ({ mime: file.mime, base64: dependencies.readBase64(file.path) }));

  const execute = createStreamRuntime<ApiHandle, ApiRunState, object>({
    limiter: dependencies.limiter,
    temporaryDirectory: join(tmpdir(), "branchboard-api"),
    createState: () => ({ isFinished: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    translate: (line, state) => provider.translate(line, state),
    open: async (handle, input, scope) => {
      const credential = credentials.credentialOf(provider.id);
      const controller = new AbortController();
      const chat: ChatInput = { model: handle.model, system: scope.systemNote, text: input, images: imagesOf(scope.files) };
      const response = await send(
        provider.chatUrl(credential.baseUrl),
        { method: "POST", headers: { ...provider.headers(credential.key), "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(provider.chatBody(chat)), signal: AbortSignal.any([scope.signal, controller.signal]) },
        HEADER_TIMEOUT_MS,
      );
      if (!response.ok) throw await requestFailure(response);
      if (!response.body) throw new Error("The server sent no answer");
      return {
        lines: sseData(response.body),
        kill: () => controller.abort(),
        endFailure: async (state) => (state.finishReason ? { type: "done" } : { type: "failure", message: "The connection closed before the answer finished" }),
      };
    },
  });

  return {
    id: provider.id,
    canSuggestTitles: true,
    catalog,
    testConnection,
    forgetCaches: () => modelsCache.clear(),
    openSession,
    execute,
    eventMap: { ...streamEventMap, usage: usageEvents, done: doneEvents },
    answerRequest: async () => undefined,
  };
};
