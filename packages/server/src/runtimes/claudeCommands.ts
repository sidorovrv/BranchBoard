import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogCommand } from "@branchboard/core";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const DESCRIPTION_PATTERN = /^description:\s*(.+)$/m;

export const BUNDLED_COMMANDS: CatalogCommand[] = [
  { name: "security-review", description: "Security review of the pending changes (run by claude itself)", template: "", passThrough: true },
];

const parseCommandFile = (name: string, raw: string): CatalogCommand => {
  const match = FRONTMATTER_PATTERN.exec(raw);
  const description = match ? DESCRIPTION_PATTERN.exec(match[1])?.[1].trim().replace(/^["']|["']$/g, "") : undefined;
  return { name, description, template: (match ? match[2] : raw).trim() };
};

export const withBundledCommands = (workspaceCommands: CatalogCommand[]): CatalogCommand[] => [
  ...workspaceCommands,
  ...BUNDLED_COMMANDS.filter((bundled) => !workspaceCommands.some((command) => command.name === bundled.name)),
];

export const listWorkspaceCommands = (workspacePath: string): CatalogCommand[] => {
  const directory = join(workspacePath, ".claude", "commands");
  try {
    return readdirSync(directory)
      .filter((file) => file.endsWith(".md"))
      .map((file) => parseCommandFile(file.slice(0, -3), readFileSync(join(directory, file), "utf8")));
  } catch {
    return [];
  }
};
