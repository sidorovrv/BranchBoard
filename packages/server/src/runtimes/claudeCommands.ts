import { join } from "node:path";
import type { CatalogCommand } from "@branchboard/core";
import { readCommandSources } from "../commandFiles";

export const BUNDLED_COMMANDS: CatalogCommand[] = [
  { name: "security-review", description: "Security review of the pending changes (run by claude itself)", template: "", passThrough: true },
];

export const withBundledCommands = (workspaceCommands: CatalogCommand[]): CatalogCommand[] => [
  ...workspaceCommands,
  ...BUNDLED_COMMANDS.filter((bundled) => !workspaceCommands.some((command) => command.name === bundled.name)),
];

export const listWorkspaceCommands = (workspacePath: string): CatalogCommand[] =>
  readCommandSources({ folders: [join(workspacePath, ".claude", "commands")], separator: ":" });
