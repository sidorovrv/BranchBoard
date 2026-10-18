import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { CatalogCommand } from "@branchboard/core";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const MAX_ANCESTOR_LEVELS = 12;
const MAX_FOLDER_DEPTH = 6;

const unquoted = (value: string): string => value.trim().replace(/^["']|["']$/g, "");

const frontMatterFields = (block: string): Record<string, string> =>
  Object.fromEntries(
    block
      .split(/\r?\n/)
      .map((line) => /^([A-Za-z_-]+):\s*(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1], unquoted(match[2])]),
  );

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

export const commandsFromConfig = (config: unknown): CatalogCommand[] => {
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
