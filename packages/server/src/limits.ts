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

const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null;

const windowsOf = (info: Record<string, any>): LimitWindow[] =>
  Object.entries(isRecord(info.unifiedWindows) ? info.unifiedWindows : {}).flatMap(([id, entry]) =>
    isRecord(entry) && typeof entry.utilization === "number" && typeof entry.resetsAt === "number" ? [{ id, utilization: entry.utilization, resetsAt: entry.resetsAt }] : [],
  );

const isSavedLimits = (value: unknown): value is RateLimits =>
  isRecord(value) && typeof value.status === "string" && typeof value.updatedAt === "number" && Array.isArray(value.windows);

const loadSaved = (filePath: string): RateLimits | undefined => {
  try {
    const saved: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isSavedLimits(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
};

const save = (filePath: string, limits: RateLimits) => {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(limits));
  } catch (error) {
    log.warn("limits", "Could not save the usage limits", error);
  }
};

const appendHistory = (historyPath: string, limits: RateLimits, source?: LimitsSource) => {
  try {
    mkdirSync(dirname(historyPath), { recursive: true });
    appendFileSync(historyPath, `${JSON.stringify({ at: new Date(limits.updatedAt).toISOString(), ...source, status: limits.status, windows: limits.windows })}\n`);
  } catch (error) {
    log.warn("limits", "Could not write the usage limits history", error);
  }
};

export const createLimitsStore = (filePath?: string, historyPath?: string): LimitsStore => {
  let latest: RateLimits | undefined = filePath ? loadSaved(filePath) : undefined;
  return {
    record: (info, source) => {
      if (!isRecord(info)) return;
      latest = { status: typeof info.status === "string" ? info.status : "unknown", windows: windowsOf(info), updatedAt: now() };
      if (filePath) save(filePath, latest);
      if (historyPath) appendHistory(historyPath, latest, source);
    },
    current: () => latest,
  };
};
