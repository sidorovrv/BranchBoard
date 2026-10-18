import type { CatalogCommand } from "./types";

const SLASH_PATTERN = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/;
const MENTION_PATTERN = /(^|\s)@([^\s@]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

export interface ExpandedPrompt {
  text: string;
  command?: CatalogCommand;
}

const WORD_PATTERN = /"([^"]*)"|'([^']*)'|(\S+)/g;
const PLACEHOLDER_PATTERN = /\$(\d)/g;

export const commandWordsOf = (argumentsText: string): string[] => [...argumentsText.matchAll(WORD_PATTERN)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

export const fillTemplate = (template: string, argumentsText: string): string => {
  const words = commandWordsOf(argumentsText);
  const highest = Math.max(0, ...[...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => Number(match[1])));
  const positional = template.replace(PLACEHOLDER_PATTERN, (_match, index: string) => {
    const position = Number(index);
    if (position === highest) return words.slice(position - 1).join(" ");
    return words[position - 1] ?? "";
  });
  if (positional.includes("$ARGUMENTS")) return positional.replaceAll("$ARGUMENTS", argumentsText);
  return argumentsText && highest === 0 ? `${positional}\n\n${argumentsText}` : positional;
};

export const slashCommandOf = (prompt: string): { name: string; argumentsText: string } | undefined => {
  const match = SLASH_PATTERN.exec(prompt.trim());
  return match ? { name: match[1] ?? "", argumentsText: (match[2] ?? "").trim() } : undefined;
};

export const expandSlashCommand = (prompt: string, commands: CatalogCommand[] | undefined): ExpandedPrompt => {
  const parsed = slashCommandOf(prompt);
  const command = parsed && commands?.find((candidate) => candidate.name === parsed.name);
  if (!command || !parsed) return { text: prompt };
  return { text: command.passThrough ? prompt.trim() : fillTemplate(command.template, parsed.argumentsText), command };
};

export const mentionTokensOf = (prompt: string): string[] =>
  [...prompt.matchAll(MENTION_PATTERN)].map((match) => (match[2] ?? "").replace(TRAILING_PUNCTUATION, "")).filter(Boolean);

export const filterCommands = (commands: CatalogCommand[], query: string): CatalogCommand[] =>
  commands.filter((command) => command.name.toLowerCase().startsWith(query.toLowerCase()));
