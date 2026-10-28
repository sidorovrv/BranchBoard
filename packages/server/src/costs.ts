import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { COST_WINDOWS, now, type CostSummary, type Id } from "@branchboard/core";
import { log } from "./log";

export const COST_RETENTION_MS = COST_WINDOWS[COST_WINDOWS.length - 1].ms;

export interface CostEntry {
  at: number;
  boardId: Id;
  nodeId: Id;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostStore {
  track(entry: CostEntry): void;
  release(nodeId: Id): void;
  record(entry: CostEntry): void;
  windows(currentTime?: number): CostSummary[];
}

const isEntry = (value: unknown): value is CostEntry => {
  const entry = value as Partial<CostEntry> | null;
  return typeof entry?.at === "number" && typeof entry.costUsd === "number" && typeof entry.inputTokens === "number" && typeof entry.outputTokens === "number";
};

const loadRecent = (historyPath: string): CostEntry[] => {
  try {
    return readFileSync(historyPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return isEntry(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      })
      .filter((entry) => entry.at > now() - COST_RETENTION_MS);
  } catch {
    return [];
  }
};

export const createCostStore = (historyPath?: string): CostStore => {
  let entries: CostEntry[] = historyPath ? loadRecent(historyPath) : [];
  const running = new Map<Id, CostEntry>();
  return {
    track: (entry) => {
      running.set(entry.nodeId, { ...entry, at: running.get(entry.nodeId)?.at ?? entry.at });
    },
    release: (nodeId) => {
      running.delete(nodeId);
    },
    record: (entry) => {
      running.delete(entry.nodeId);
      entries.push(entry);
      if (!historyPath) return;
      try {
        mkdirSync(dirname(historyPath), { recursive: true });
        appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
      } catch (error) {
        log.warn("costs", "Could not write the cost history", error);
      }
    },
    windows: (currentTime = now()) => {
      entries = entries.filter((entry) => entry.at > currentTime - COST_RETENTION_MS);
      const all = [...entries, ...running.values()];
      return COST_WINDOWS.map(({ id, ms }) => {
        const inWindow = all.filter((entry) => entry.at > currentTime - ms);
        return {
          id,
          costUsd: inWindow.reduce((total, entry) => total + entry.costUsd, 0),
          runs: inWindow.length,
          inputTokens: inWindow.reduce((total, entry) => total + entry.inputTokens, 0),
          outputTokens: inWindow.reduce((total, entry) => total + entry.outputTokens, 0),
          windowMs: ms,
        };
      });
    },
  };
};
