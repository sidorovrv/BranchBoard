import { rmSync } from "node:fs";
import { join } from "node:path";

export interface LogSource {
  id: string;
  path: (dataDirectory: string) => string;
  inReport: "tail" | "errors" | "no";
  clearable: boolean;
}

export const LOG_SOURCES: LogSource[] = [
  { id: "server", path: (dataDirectory) => join(dataDirectory, "logs"), inReport: "tail", clearable: true },
  { id: "run-logs", path: (dataDirectory) => join(dataDirectory, "run-logs"), inReport: "errors", clearable: true },
  { id: "perf", path: (dataDirectory) => join(dataDirectory, "perf"), inReport: "tail", clearable: true },
  { id: "limits-history", path: (dataDirectory) => join(dataDirectory, "limits-history.jsonl"), inReport: "no", clearable: true },
  { id: "costs-history", path: (dataDirectory) => join(dataDirectory, "costs-history.jsonl"), inReport: "no", clearable: true },
];

export const clearLogs = (dataDirectory: string): string[] =>
  LOG_SOURCES.filter((source) => source.clearable).map((source) => {
    rmSync(source.path(dataDirectory), { recursive: true, force: true });
    return source.id;
  });
