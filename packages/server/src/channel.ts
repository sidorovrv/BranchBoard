import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_NAME, VERSION_PATTERN, type UpdateTags } from "@branchboard/core";
import { log } from "./log";

export const CHANNEL_URL = "https://raw.githubusercontent.com/sidorovrv/BranchBoard/main/channel.json";
export const TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_CHANNEL_BYTES = 64 * 1024;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.-]{0,79}$/;

export interface ChannelModel {
  id: string;
  name: string;
}

export interface ChannelContents {
  tags: UpdateTags;
  minimumVersion?: string;
  claudeModels: ChannelModel[];
}

interface CachedChannel {
  fetchedAt: number;
  checkedAt?: number;
  error?: string;
  contents: ChannelContents;
}

export interface ChannelStatus {
  checkedAt: number | null;
  error: string | null;
  isOffline: boolean;
}

export type FetchText = (url: string) => Promise<string>;

const asText = (value: unknown, maxLength: number): string | undefined => (typeof value === "string" && value.length <= maxLength ? value : undefined);

const objectOf = (raw: unknown): Record<string, unknown> => (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

export const parseTags = (raw: unknown): UpdateTags => {
  const latest = asText(objectOf(raw).latest, 40);
  return latest && VERSION_PATTERN.test(latest) ? { latest } : {};
};

export const parseChannel = (raw: unknown): ChannelContents => {
  const source = objectOf(raw);
  const minimumVersion = asText(source.minimumVersion, 40);
  const claudeModels = (Array.isArray(source.claudeModels) ? source.claudeModels : []).flatMap((entry): ChannelModel[] => {
    const id = asText(entry?.id, 80);
    const name = asText(entry?.name, 80);
    return id && name && MODEL_ID_PATTERN.test(id) ? [{ id, name }] : [];
  });
  return { tags: parseTags(source.tags), minimumVersion: minimumVersion && VERSION_PATTERN.test(minimumVersion) ? minimumVersion : undefined, claudeModels: claudeModels.slice(0, 30) };
};

const readJsonFile = <T>(path: string, fallback: T): T => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJsonFile = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
};

export const fetchRemoteText: FetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error", credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_CHANNEL_BYTES) throw new Error("Channel file is too large");
  return text;
};

const channelFileOverride = (): string | undefined => process.env.BRANCHBOARD_CHANNEL_FILE || undefined;

const fetchFileText = (path: string): FetchText => async (url) => {
  const text = readFileSync(path, "utf8");
  return url === TAGS_URL ? JSON.stringify(objectOf(JSON.parse(text)).tags ?? {}) : text;
};

export const defaultFetchText = (): FetchText => {
  const file = channelFileOverride();
  return file ? fetchFileText(file) : fetchRemoteText;
};

const settle = async <T>(task: () => Promise<T>): Promise<{ value?: T; error?: string }> => {
  try {
    return { value: await task() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export interface ChannelOptions {
  dataDirectory: string;
  isOffline?: () => boolean;
  fetchText?: FetchText;
  clock?: () => number;
}

export interface RefreshOptions {
  force?: boolean;
}

export interface RemoteChannel {
  contents: () => ChannelContents;
  status: () => ChannelStatus;
  seenModels: () => ChannelModel[];
  recordSeenModel: (id: string) => void;
  refresh: (options?: RefreshOptions) => Promise<void>;
}

export const createRemoteChannel = ({ dataDirectory, isOffline = () => process.env.BRANCHBOARD_OFFLINE === "1", fetchText, clock = Date.now }: ChannelOptions): RemoteChannel => {
  const channelPath = join(dataDirectory, "channel.json");
  const seenPath = join(dataDirectory, "models-seen.json");
  const cached = (): CachedChannel | undefined => readJsonFile<CachedChannel | undefined>(channelPath, undefined);
  const seen = (): string[] => readJsonFile<string[]>(seenPath, []).filter((id) => typeof id === "string" && MODEL_ID_PATTERN.test(id));
  const contents = () => parseChannel(cached()?.contents);
  return {
    contents,
    status: () => ({ checkedAt: cached()?.checkedAt ?? null, error: cached()?.error ?? null, isOffline: isOffline() }),
    seenModels: () => seen().map((id) => ({ id, name: id })),
    recordSeenModel: (id) => {
      if (MODEL_ID_PATTERN.test(id) && !seen().includes(id)) writeJsonFile(seenPath, [...seen(), id].slice(-30));
    },
    refresh: async ({ force = false } = {}) => {
      if (isOffline()) return;
      const previous = cached();
      const isFileSource = channelFileOverride() !== undefined && fetchText === undefined;
      if (!force && !isFileSource && previous && clock() - previous.fetchedAt < ONE_DAY_MS) return;
      const source = fetchText ?? defaultFetchText();
      const [tags, channel] = await Promise.all([settle(async () => parseTags(JSON.parse(await source(TAGS_URL)))), settle(async () => parseChannel(JSON.parse(await source(CHANNEL_URL))))]);
      if (tags.error) log.warn("channel", `Could not check npm for a newer version: ${tags.error}`);
      if (channel.error) log.debug("channel", `Could not fetch channel.json: ${channel.error}`);
      const known = contents();
      const hasChecked = tags.value !== undefined;
      writeJsonFile(
        channelPath,
        {
          fetchedAt: hasChecked ? clock() : clock() - (ONE_DAY_MS - RETRY_AFTER_FAILURE_MS),
          checkedAt: hasChecked ? clock() : previous?.checkedAt,
          error: tags.error,
          contents: { ...(channel.value ?? known), tags: tags.value ?? known.tags },
        } satisfies CachedChannel,
      );
    },
  };
};
