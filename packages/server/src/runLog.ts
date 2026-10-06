import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Id } from "@branchboard/core";
import { log } from "./log";

export type RunLogRecord = { event: "start" | "end" | "title" | "summary"; boardId: Id; nodeId: Id; roll: number } & Record<string, unknown>;

export const createRunLog = (directory: string) => {
  const append = (record: RunLogRecord) => {
    try {
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, `${record.boardId}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    } catch (error) {
      log.warn("runlog", "Could not write the run log", error);
    }
  };
  return { append };
};

export type RunLog = ReturnType<typeof createRunLog>;
