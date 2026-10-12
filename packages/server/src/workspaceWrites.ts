import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { escapesFolder, isSensitivePath, MAX_EXTRACTED_FILE_BYTES } from "@branchboard/core";
import { RefusedError } from "./boards";

export const hashOfBytes = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export const resolveInsideWorkspace = (workspacePath: string, relativePath: string): string => {
  const root = realpathSync(workspacePath);
  const target = resolve(root, relativePath);
  const inside = relative(root, target);
  if (inside === "" || escapesFolder(inside)) throw new RefusedError(`${relativePath} is not inside the project folder`);
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (escapesFolder(relative(root, realpathSync(ancestor)))) throw new RefusedError(`${relativePath} leads outside the project folder`);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new RefusedError(`${relativePath} is a link and is not changed`);
  return target;
};

export interface FileState {
  text: string | null;
  hash: string | null;
}

export const readWorkspaceState = (workspacePath: string, relativePath: string): FileState => {
  const target = resolveInsideWorkspace(workspacePath, relativePath);
  if (!existsSync(target)) return { text: null, hash: null };
  if (!statSync(target).isFile()) throw new RefusedError(`${relativePath} is not a file`);
  if (statSync(target).size > MAX_EXTRACTED_FILE_BYTES) throw new RefusedError(`${relativePath} is too large to restore`);
  const bytes = readFileSync(target);
  if (bytes.includes(0)) throw new RefusedError(`${relativePath} is not a text file`);
  return { text: bytes.toString("utf8"), hash: hashOfBytes(bytes) };
};

export interface WriteOptions {
  expectedHash?: string | null;
  allowSensitive?: boolean;
}

export const writeWorkspaceFile = (workspacePath: string, relativePath: string, content: string | null, { expectedHash, allowSensitive = false }: WriteOptions = {}): void => {
  if (isSensitivePath(relativePath) && !allowSensitive) throw new RefusedError(`${relativePath} is on the sensitive list`);
  const target = resolveInsideWorkspace(workspacePath, relativePath);
  if (expectedHash !== undefined && readWorkspaceState(workspacePath, relativePath).hash !== expectedHash) throw new RefusedError(`${relativePath} changed since it was read`);
  if (content === null) return void rmSync(target, { force: true });
  if (Buffer.byteLength(content) > MAX_EXTRACTED_FILE_BYTES) throw new RefusedError(`${relativePath} is too large to write`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
};
