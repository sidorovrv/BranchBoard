import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactDeep, type RedactionContext } from "@branchboard/core";
import { LOG_SOURCES, type LogSource } from "./logSources";

const MAX_REPORT_RECORDS = 200;
const STRIPPED_KEYS = ["input", "output"];

const filesNewestFirst = (path: string): string[] => {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .map((name) => join(path, name))
    .filter((file) => statSync(file).isFile())
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
};

const LOG_ENTRY_START = /\r?\n(?=\d{4}-\d\d-\d\dT)/;
const FULL_COMMAND_ENTRY = /^\S+\s+\w+\s+\[command\] .*\(full\)/;

const linesOf = (file: string): string[] => {
  const text = readFileSync(file, "utf8");
  return file.endsWith(".log") ? text.split(LOG_ENTRY_START).filter((entry) => entry && !FULL_COMMAND_ENTRY.test(entry)) : text.split(/\r?\n/).filter(Boolean);
};

const parsedRecordsOf = (lines: string[]): Record<string, unknown>[] =>
  lines.flatMap((line) => {
    try {
      const record = JSON.parse(line);
      return typeof record === "object" && record !== null ? [record] : [];
    } catch {
      return [];
    }
  });

const withoutPrompts = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([key]) => !STRIPPED_KEYS.includes(key)));

const failedRunsOf = (lines: string[]) =>
  parsedRecordsOf(lines)
    .filter((record) => record.event === "end" && Array.isArray(record.errors) && record.errors.length > 0)
    .map(withoutPrompts);

const REPORT_PICKERS: Record<Exclude<LogSource["inReport"], "no">, (files: string[]) => unknown[]> = {
  tail: (files) => (files[0] ? linesOf(files[0]).slice(-MAX_REPORT_RECORDS) : []),
  errors: (files) => files.flatMap((file) => failedRunsOf(linesOf(file))).slice(-MAX_REPORT_RECORDS),
};

export interface ReportInput {
  dataDirectory: string;
  version: string;
  health: unknown;
  counts: Record<string, number>;
  redaction: RedactionContext;
}

export const buildReport = ({ dataDirectory, version, health, counts, redaction }: ReportInput) =>
  redactDeep(
    {
      generatedAt: new Date().toISOString(),
      app: { version, platform: process.platform, arch: process.arch, node: process.version },
      health,
      counts,
      logs: Object.fromEntries(
        LOG_SOURCES.filter((source) => source.inReport !== "no").map((source) => [source.id, REPORT_PICKERS[source.inReport as "tail" | "errors"](filesNewestFirst(source.path(dataDirectory)))]),
      ),
    },
    redaction,
  );
