import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { isSensitivePath } from "@branchboard/core";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".json": "application/json",
};

const TEXT_EXTENSIONS = [".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".html", ".py", ".sql", ".yaml", ".yml", ".toml", ".csv", ".sh", ".go", ".rs", ".java", ".c", ".h", ".cpp"];

const PAGE_EXTENSIONS = [".html", ".htm"];
const PAGE_SANDBOX = "sandbox allow-scripts allow-popups allow-forms allow-modals";
const INERT_SANDBOX = "sandbox";

export const mimeOfPath = (path: string): string => {
  const extension = extname(path).toLowerCase();
  if (MIME_BY_EXTENSION[extension]) return MIME_BY_EXTENSION[extension];
  return TEXT_EXTENSIONS.includes(extension) ? "text/plain" : "application/octet-stream";
};

const insideWorkspace = (workspacePath: string, candidate: string): boolean => {
  const path = relative(realpathSync(workspacePath), realpathSync(candidate));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
};

export const existingWorkspaceFile = (workspacePath: string, requested: string): string | undefined => {
  const path = resolve(workspacePath, requested);
  try {
    return existsSync(path) && statSync(path).isFile() && insideWorkspace(workspacePath, path) ? path : undefined;
  } catch {
    return undefined;
  }
};

export interface ServedFile {
  contentType: string;
  disposition: "inline" | "attachment";
  policy?: string;
}

export const servedFileOf = (path: string): ServedFile => {
  const extension = extname(path).toLowerCase();
  if (PAGE_EXTENSIONS.includes(extension)) return { contentType: "text/html; charset=utf-8", disposition: "inline", policy: PAGE_SANDBOX };
  if (extension === ".svg") return { contentType: "image/svg+xml", disposition: "inline", policy: INERT_SANDBOX };
  const mime = mimeOfPath(path);
  if (mime === "application/octet-stream") return { contentType: mime, disposition: "attachment", policy: INERT_SANDBOX };
  if (mime === "application/pdf") return { contentType: mime, disposition: "inline" };
  return { contentType: mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime, disposition: "inline", policy: INERT_SANDBOX };
};

export const downloadNameOf = (path: string): string => encodeURIComponent(basename(path));

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "out", "target", "__pycache__", "venv", ".venv"]);
const MAX_DEPTH = 8;
const MAX_SCANNED = 20000;
export const MAX_FILE_RESULTS = 30;

const ignoredNamesOf = (workspacePath: string): Set<string> => {
  try {
    const lines = readFileSync(join(workspacePath, ".gitignore"), "utf8").split(/\r?\n/);
    return new Set(lines.map((line) => line.trim().replace(/^\/+|\/+$/g, "")).filter((line) => line && !line.startsWith("#") && !line.startsWith("!") && !/[*?[\]]/.test(line)));
  } catch {
    return new Set();
  }
};

const walk = (workspacePath: string): string[] => {
  const ignored = ignoredNamesOf(workspacePath);
  const found: string[] = [];
  const visit = (relativeDirectory: string, depth: number) => {
    if (depth > MAX_DEPTH || found.length >= MAX_SCANNED) return;
    let entries;
    try {
      entries = readdirSync(join(workspacePath, relativeDirectory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || ignored.has(entry.name) || ignored.has(relativePath)) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(relativePath, depth + 1);
      } else if (entry.isFile()) found.push(relativePath);
    }
  };
  visit("", 0);
  return found;
};

const rank = (path: string, query: string): number => {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  return 2;
};

export const searchWorkspaceFiles = (workspacePath: string, query: string): string[] => {
  const needle = query.trim().toLowerCase();
  const matches = walk(workspacePath).filter((path) => path.toLowerCase().includes(needle) && !isSensitivePath(path));
  return matches.sort((left, right) => rank(left, needle) - rank(right, needle) || left.length - right.length).slice(0, MAX_FILE_RESULTS);
};
