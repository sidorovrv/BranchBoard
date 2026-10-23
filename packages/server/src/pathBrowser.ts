import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { RefusedError } from "./boards";
import { isSensitivePath } from "@branchboard/core";
import { pathInsideWorkspace } from "./workspaceFiles";

export interface BrowsedEntry {
  name: string;
  isFolder: boolean;
}

export interface BrowsedFolder {
  path: string;
  parent: string | null;
  entries: BrowsedEntry[];
}

const MAX_ENTRIES = 1000;

export const requireLocalFolder = (path: unknown): string => {
  if (typeof path !== "string" || !isAbsolute(path) || /^[\\/]{2}/.test(path) || !safeIsFolder(path)) throw new RefusedError("That is not an existing local folder");
  return path;
};

export const browseFolder = (requested: string | undefined, includeFiles: boolean): BrowsedFolder => {
  const path = requireLocalFolder(resolve(requested || homedir()));
  const entries = readdirSync(path, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, isFolder: entry.isDirectory() || (entry.isSymbolicLink() && safeIsFolder(join(path, entry.name))) }))
    .filter((entry) => entry.isFolder || (includeFiles && !isSensitivePath(entry.name)))
    .sort((left, right) => Number(right.isFolder) - Number(left.isFolder) || left.name.localeCompare(right.name))
    .slice(0, MAX_ENTRIES);
  const parentPath = dirname(path);
  return { path, parent: parentPath === path ? null : parentPath, entries };
};

const safeIsFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export const insideWorkspace = (workspacePath: string, picked: string): string => {
  const relativePath = pathInsideWorkspace(workspacePath, picked);
  if (!relativePath) throw new RefusedError("Choose a file inside the project folder");
  return relativePath;
};
