import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { now, type CostSummary, type Id } from "@branchboard/core";
import { log } from "./log";

export const COST_WINDOW_MS = 60 * 60 * 1000;

export interface CostEntry {
  at: number;
  boardId: Id;
  nodeId: Id;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostStore {
  record(entry: CostEntry): void;
  lastHour(currentTime?: number): CostSummary;
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
      .filter((entry) => entry.at > now() - COST_WINDOW_MS);
  } catch {
    return [];
  }
};

export const createCostStore = (historyPath?: string): CostStore => {
  let entries: CostEntry[] = historyPath ? loadRecent(historyPath) : [];
  return {
    record: (entry) => {
      entries.push(entry);
      if (!historyPath) return;
      try {
        mkdirSync(dirname(historyPath), { recursive: true });
        appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
      } catch (error) {
        log.warn("costs", "Could not write the cost history", error);
      }
    },
    lastHour: (currentTime = now()) => {
      entries = entries.filter((entry) => entry.at > currentTime - COST_WINDOW_MS);
      return {
        costUsd: entries.reduce((total, entry) => total + entry.costUsd, 0),
        runs: entries.length,
        inputTokens: entries.reduce((total, entry) => total + entry.inputTokens, 0),
        outputTokens: entries.reduce((total, entry) => total + entry.outputTokens, 0),
        windowMs: COST_WINDOW_MS,
      };
    },
  };
};
