import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const readJsonFile = <T>(path: string, fallback: T): T => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
};

const LOCKED_FILE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 50;

const pause = (milliseconds: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

export const replaceFile = (temporary: string, path: string) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return renameSync(temporary, path);
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !LOCKED_FILE_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      pause(RENAME_RETRY_MS * attempt);
    }
  }
};

export const writeJsonFile = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  replaceFile(temporary, path);
};

export const appendJsonLine = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
};
