import type { CatalogCommand } from "./types";

const SLASH_PATTERN = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/;
const MENTION_PATTERN = /(^|\s)@([^\s@]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

export interface ExpandedPrompt {
  text: string;
  command?: CatalogCommand;
}

const fillTemplate = (template: string, argumentsText: string): string => {
  const words = argumentsText.split(/\s+/).filter(Boolean);
  const positional = template.replace(/\$(\d)/g, (_match, index: string) => words[Number(index) - 1] ?? "");
  if (positional.includes("$ARGUMENTS")) return positional.replaceAll("$ARGUMENTS", argumentsText);
  const usesPositionalArguments = positional !== template;
  return argumentsText && !usesPositionalArguments ? `${positional}\n\n${argumentsText}` : positional;
};

export const slashCommandOf = (prompt: string): { name: string; argumentsText: string } | undefined => {
  const match = SLASH_PATTERN.exec(prompt.trim());
  return match ? { name: match[1], argumentsText: (match[2] ?? "").trim() } : undefined;
};

export const expandSlashCommand = (prompt: string, commands: CatalogCommand[] | undefined): ExpandedPrompt => {
  const parsed = slashCommandOf(prompt);
  const command = parsed && commands?.find((candidate) => candidate.name === parsed.name);
  if (!command || !parsed) return { text: prompt };
  return { text: command.passThrough ? prompt.trim() : fillTemplate(command.template, parsed.argumentsText), command };
};

export const mentionTokensOf = (prompt: string): string[] =>
  [...prompt.matchAll(MENTION_PATTERN)].map((match) => match[2].replace(TRAILING_PUNCTUATION, "")).filter(Boolean);

export const filterCommands = (commands: CatalogCommand[], query: string): CatalogCommand[] =>
  commands.filter((command) => command.name.toLowerCase().startsWith(query.toLowerCase()));
