import { homedir } from "node:os";
import { join } from "node:path";
import type { CatalogCommand } from "@branchboard/core";
import { readCommandSources, readSkillFolder } from "../commandFiles";

const MAX_COMMANDS = 300;
const MAX_NAME_LENGTH = 120;

const TERMINAL_SESSION_COMMANDS = new Set([
  "advisor", "agents", "auto-mode-setup", "autocompact", "clear", "color", "compact", "config", "context", "design-consent", "design-revoke", "effort", "extra-usage", "fast", "focus", "goal", "heapdump", "import",
  "insights", "list-agents", "mcp", "model", "output-style", "recap", "reload-plugins", "reload-skills", "rename", "skill-doctor", "team-onboarding", "usage", "usage-credits", "workflow-launch-exec",
]);

export const BUNDLED_COMMANDS: CatalogCommand[] = [
  { name: "security-review", description: "Security review of the pending changes (run by claude itself)", template: "", passThrough: true },
];

export const withBundledCommands = (...lists: CatalogCommand[][]): CatalogCommand[] =>
  [...lists.flat(), ...BUNDLED_COMMANDS].filter((command, index, all) => all.findIndex((other) => other.name === command.name) === index);

export const listWorkspaceCommands = (workspacePath: string, home = homedir()): CatalogCommand[] => [
  ...readSkillFolder(join(workspacePath, ".claude", "skills")),
  ...readSkillFolder(join(home, ".claude", "skills")),
  ...readCommandSources({ folders: [join(home, ".claude", "commands"), join(workspacePath, ".claude", "commands")], separator: ":" }),
];

export const commandsFromInitialize = (raw: unknown): CatalogCommand[] =>
  (Array.isArray(raw) ? raw.slice(0, MAX_COMMANDS) : []).flatMap((entry): CatalogCommand[] => {
    const name = entry?.name;
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH || name.startsWith("__") || TERMINAL_SESSION_COMMANDS.has(name)) return [];
    const description = typeof entry.description === "string" && !entry.description.startsWith("(removed)") ? entry.description : undefined;
    return [{ name, template: "", passThrough: true, ...(description ? { description } : {}) }];
  });
