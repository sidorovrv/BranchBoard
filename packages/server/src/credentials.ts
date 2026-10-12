import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isApiRuntime, isLocalBaseUrl, needsKey, runtimeInfo, type ApiRuntimeId, type CredentialStatus, type RuntimeId } from "@branchboard/core";
import { RefusedError } from "./boards";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_KEY_CHARS = 512;

interface StoredCredential {
  key?: string;
  baseUrl: string;
  updatedAt: number;
}

type StoredCredentials = Partial<Record<ApiRuntimeId, StoredCredential>>;

export interface ApiCredential {
  key?: string;
  baseUrl: string;
}

export const normaliseBaseUrl = (runtimeId: ApiRuntimeId, requested: string | undefined): string => {
  const { credential } = runtimeInfo(runtimeId);
  if (!credential) throw new RefusedError(`${runtimeId} does not use an API key`);
  if (!credential.baseUrlEditable || !requested?.trim()) return credential.defaultBaseUrl;
  let url: URL;
  try {
    url = new URL(requested.trim());
  } catch {
    throw new RefusedError("That is not a valid web address");
  }
  if (url.username || url.password || url.search || url.hash) throw new RefusedError("The address must not contain a login, query or fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalBaseUrl(url.href))) throw new RefusedError("The address must start with https:// (http:// is only accepted for this computer)");
  return url.href.replace(/\/+$/, "");
};

const requireApiRuntime = (runtimeId: RuntimeId): ApiRuntimeId => {
  if (!isApiRuntime(runtimeId)) throw new RefusedError(`${runtimeId} does not use an API key`);
  return runtimeId;
};

export const createCredentialStore = (dataDirectory: string) => {
  const path = join(dataDirectory, "credentials.json");

  const load = (): StoredCredentials => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as StoredCredentials) : {};
    } catch {
      return {};
    }
  };

  const save = (credentials: StoredCredentials) => {
    mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(credentials), { mode: PRIVATE_FILE_MODE });
    chmodSync(temporary, PRIVATE_FILE_MODE);
    renameSync(temporary, path);
  };

  const status = (runtimeId: RuntimeId): CredentialStatus => {
    const info = runtimeInfo(runtimeId).credential;
    const stored = isApiRuntime(runtimeId) ? load()[runtimeId] : undefined;
    return { saved: Boolean(stored?.key), baseUrl: stored?.baseUrl ?? info?.defaultBaseUrl ?? "", updatedAt: stored?.key ? stored.updatedAt : undefined };
  };

  const set = (runtimeId: RuntimeId, key: string | null | undefined, requestedBaseUrl: string | undefined): CredentialStatus => {
    const id = requireApiRuntime(runtimeId);
    const credentials = load();
    const previous = credentials[id];
    const baseUrl = normaliseBaseUrl(id, requestedBaseUrl ?? previous?.baseUrl);
    if (typeof key === "string" && (key.length === 0 || key.length > MAX_KEY_CHARS || /\s/.test(key))) throw new RefusedError("That does not look like an API key");
    const keptKey = key === undefined ? (previous?.baseUrl === baseUrl ? previous.key : undefined) : (key ?? undefined);
    credentials[id] = { baseUrl, ...(keptKey ? { key: keptKey } : {}), updatedAt: Date.now() };
    save(credentials);
    return status(id);
  };

  const credentialOf = (runtimeId: ApiRuntimeId): ApiCredential => {
    const stored = load()[runtimeId];
    return { key: stored?.key, baseUrl: stored?.baseUrl ?? runtimeInfo(runtimeId).credential!.defaultBaseUrl };
  };

  const isReady = (runtimeId: ApiRuntimeId): boolean => {
    const { key, baseUrl } = credentialOf(runtimeId);
    return Boolean(key) || !needsKey(runtimeId, baseUrl);
  };

  return { status, set, credentialOf, isReady, secretValues: (): string[] => Object.values(load()).flatMap((entry) => (entry?.key ? [entry.key] : [])) };
};

export type CredentialStore = ReturnType<typeof createCredentialStore>;
