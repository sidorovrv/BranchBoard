import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { now, type Id, type LimitWindow, type RateLimits } from "@branchboard/core";
import { log } from "./log";

export interface LimitsSource {
  boardId: Id;
  nodeId: Id;
}

export interface LimitsStore {
  record(info: unknown, source?: LimitsSource): void;
  current(): RateLimits | undefined;
}

export interface LimitsBook {
  of(runtime: string): LimitsStore;
  current(runtime: string): RateLimits | undefined;
}

const LEGACY_RUNTIME = "claude";

const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null;

const windowsOf = (info: Record<string, any>): LimitWindow[] =>
  Object.entries(isRecord(info.unifiedWindows) ? info.unifiedWindows : {}).flatMap(([id, entry]) =>
    isRecord(entry) && typeof entry.utilization === "number" && typeof entry.resetsAt === "number" ? [{ id, utilization: entry.utilization, resetsAt: entry.resetsAt }] : [],
  );

const isSavedLimits = (value: unknown): value is RateLimits =>
  isRecord(value) && typeof value.status === "string" && typeof value.updatedAt === "number" && Array.isArray(value.windows);

const loadSaved = (filePath: string): Map<string, RateLimits> => {
  try {
    const saved: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (isSavedLimits(saved)) return new Map([[LEGACY_RUNTIME, saved]]);
    return new Map(Object.entries(isRecord(saved) ? saved : {}).filter((entry): entry is [string, RateLimits] => isSavedLimits(entry[1])));
  } catch {
    return new Map();
  }
};

const save = (filePath: string, latest: Map<string, RateLimits>) => {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(Object.fromEntries(latest)));
  } catch (error) {
    log.warn("limits", "Could not save the usage limits", error);
  }
};

const appendHistory = (historyPath: string, runtime: string, limits: RateLimits, source?: LimitsSource) => {
  try {
    mkdirSync(dirname(historyPath), { recursive: true });
    appendFileSync(historyPath, `${JSON.stringify({ at: new Date(limits.updatedAt).toISOString(), runtime, ...source, status: limits.status, windows: limits.windows })}\n`);
  } catch (error) {
    log.warn("limits", "Could not write the usage limits history", error);
  }
};

export const createLimitsStore = (filePath?: string, historyPath?: string): LimitsBook => {
  const latest = filePath ? loadSaved(filePath) : new Map<string, RateLimits>();
  const of = (runtime: string): LimitsStore => ({
    record: (info, source) => {
      if (!isRecord(info)) return;
      const limits: RateLimits = { status: typeof info.status === "string" ? info.status : "unknown", windows: windowsOf(info), updatedAt: now() };
      latest.set(runtime, limits);
      if (filePath) save(filePath, latest);
      if (historyPath) appendHistory(historyPath, runtime, limits, source);
    },
    current: () => latest.get(runtime),
  });
  return { of, current: (runtime) => latest.get(runtime) };
};
