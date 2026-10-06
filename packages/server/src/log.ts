import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const threshold = (): number => LEVEL_ORDER[(process.env.BRANCHBOARD_LOG_LEVEL as Level) ?? "debug"] ?? LEVEL_ORDER.debug;

const detail = (value: unknown): string => {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const MAX_LOG_FILE_BYTES = 1024 * 1024;
const KEPT_LOG_FILES = 3;
let logFilePath: string | undefined;

const rotatedName = (path: string, index: number): string => (index === 0 ? path : `${path}.${index}`);

const rotateIfLarge = (path: string) => {
  if (!existsSync(path) || statSync(path).size < MAX_LOG_FILE_BYTES) return;
  rmSync(rotatedName(path, KEPT_LOG_FILES - 1), { force: true });
  for (let index = KEPT_LOG_FILES - 2; index >= 0; index--) if (existsSync(rotatedName(path, index))) renameSync(rotatedName(path, index), rotatedName(path, index + 1));
};

export const configureLogFile = (path: string | undefined) => {
  logFilePath = path;
  if (path) mkdirSync(dirname(path), { recursive: true });
};

export const currentLogFile = (): string | undefined => logFilePath;

export const readLogTail = (maxLines: number, filter?: string): string[] => {
  if (!logFilePath) return [];
  const files = Array.from({ length: KEPT_LOG_FILES }, (_unused, index) => rotatedName(logFilePath!, index)).filter((path) => existsSync(path));
  const lines: string[] = [];
  for (const path of files) {
    const fileLines = readFileSync(path, "utf8").split(/\r?\n(?=\d{4}-\d\d-\d\dT)/).filter(Boolean);
    lines.unshift(...fileLines.filter((entry) => !filter || entry.includes(filter)));
    if (lines.length >= maxLines) break;
  }
  return lines.slice(-maxLines);
};

const writeToFile = (line: string) => {
  if (!logFilePath) return;
  try {
    rotateIfLarge(logFilePath);
    appendFileSync(logFilePath, `${line}\n`);
  } catch {
    logFilePath = undefined;
  }
};

const write = (level: Level, scope: string, message: string, extra?: unknown) => {
  if (LEVEL_ORDER[level] < threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${extra === undefined ? "" : `\n${detail(extra)}`}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
  writeToFile(line);
};

export const log = {
  debug: (scope: string, message: string, extra?: unknown) => write("debug", scope, message, extra),
  info: (scope: string, message: string, extra?: unknown) => write("info", scope, message, extra),
  warn: (scope: string, message: string, extra?: unknown) => write("warn", scope, message, extra),
  error: (scope: string, message: string, extra?: unknown) => write("error", scope, message, extra),
};
