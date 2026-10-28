import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { CatalogCommand } from "@branchboard/core";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const MAX_ANCESTOR_LEVELS = 12;
const MAX_FOLDER_DEPTH = 6;

const unquoted = (value: string): string => value.trim().replace(/^["']|["']$/g, "");

const BLOCK_SCALAR_PATTERN = /^[>|][+-]?$/;

const frontMatterFields = (block: string): Record<string, string> => {
  const lines = block.split(/\r?\n/);
  const fields: Record<string, string> = {};
  lines.forEach((line, index) => {
    const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!match) return;
    if (!BLOCK_SCALAR_PATTERN.test(match[2].trim())) {
      fields[match[1]] = unquoted(match[2]);
      return;
    }
    const continuation = [];
    for (let next = index + 1; next < lines.length && /^\s+\S|^\s*$/.test(lines[next]); next++) continuation.push(lines[next].trim());
    fields[match[1]] = continuation.join(" ").trim();
  });
  return fields;
};

export const commandOfMarkdown = (name: string, raw: string): CatalogCommand => {
  const match = FRONTMATTER_PATTERN.exec(raw);
  const fields = match ? frontMatterFields(match[1]) : {};
  const command: CatalogCommand = { name, template: (match ? match[2] : raw).trim() };
  if (fields.description) command.description = fields.description;
  if (fields.agent) command.agent = fields.agent;
  if (fields.model) command.model = fields.model;
  if (fields.subagent) command.subagent = fields.subagent === "true";
  return command;
};

const skillCommandOf = (directory: string, folderName: string): CatalogCommand[] => {
  try {
    const raw = readFileSync(join(directory, folderName, "SKILL.md"), "utf8");
    const fields = frontMatterFields(FRONTMATTER_PATTERN.exec(raw)?.[1] ?? "");
    if (fields["user-invocable"] === "false") return [];
    return [{ name: fields.name || folderName, template: "", passThrough: true, ...(fields.description ? { description: fields.description } : {}) }];
  } catch {
    return [];
  }
};

export const readSkillFolder = (directory: string): CatalogCommand[] => {
  try {
    return readdirSync(directory).flatMap((folderName) => skillCommandOf(directory, folderName));
  } catch {
    return [];
  }
};

export const commandsFromConfig =(config: unknown): CatalogCommand[] => {
  const entries = (config as { commands?: unknown } | undefined)?.commands;
  if (!entries || typeof entries !== "object") return [];
  return Object.entries(entries as Record<string, any>)
    .filter(([, entry]) => entry && typeof entry.template === "string")
    .map(([name, entry]) => ({
      name,
      template: entry.template,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(typeof entry.agent === "string" ? { agent: entry.agent } : {}),
      ...(typeof entry.model === "string" ? { model: entry.model } : {}),
      ...(typeof entry.subagent === "boolean" ? { subagent: entry.subagent } : {}),
    }));
};

export const readCommandFolder = (directory: string, separator: string, depth = 0, root = directory): CatalogCommand[] => {
  if (depth > MAX_FOLDER_DEPTH) return [];
  try {
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return readCommandFolder(path, separator, depth + 1, root);
      if (!entry.endsWith(".md")) return [];
      const name = relative(root, path).slice(0, -3).split(sep).join(separator);
      return [commandOfMarkdown(name, readFileSync(path, "utf8"))];
    });
  } catch {
    return [];
  }
};

export const ancestorFolders = (workspacePath: string, relativeFolder: string): string[] => {
  const folders: string[] = [];
  let current = workspacePath;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level++) {
    folders.push(join(current, relativeFolder));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return folders;
};

export const mergeCommands = (...lists: CatalogCommand[][]): CatalogCommand[] => [...new Map(lists.flat().map((command) => [command.name, command])).values()];

export interface CommandSources {
  folders: string[];
  separator: string;
  config?: unknown[];
}

export const readCommandSources = ({ folders, separator, config = [] }: CommandSources): CatalogCommand[] =>
  mergeCommands(...folders.map((folder) => readCommandFolder(folder, separator)), ...config.map(commandsFromConfig));
