export interface ToolInputView {
  primaryKey: string;
  primaryText: string;
  summary: string;
  remaining?: Record<string, unknown>;
}

const PRIMARY_KEYS = ["sql", "query", "command", "cmd", "code", "script", "pattern", "prompt", "url", "file_path", "path", "description"];

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

const primaryKeyOf = (input: Record<string, unknown>): string | undefined => {
  const named = PRIMARY_KEYS.find((key) => typeof input[key] === "string" && (input[key] as string).trim() !== "");
  if (named) return named;
  const stringKeys = Object.keys(input).filter((key) => typeof input[key] === "string" && (input[key] as string).trim() !== "");
  return stringKeys.length === 1 ? stringKeys[0] : undefined;
};

export const toolInputView = (input: unknown): ToolInputView | undefined => {
  if (!isPlainObject(input)) return undefined;
  const primaryKey = primaryKeyOf(input);
  if (!primaryKey) return undefined;
  const primaryText = input[primaryKey] as string;
  const remainingEntries = Object.entries(input).filter(([key]) => key !== primaryKey);
  return {
    primaryKey,
    primaryText,
    summary: collapseWhitespace(primaryText),
    remaining: remainingEntries.length > 0 ? Object.fromEntries(remainingEntries) : undefined,
  };
};

export const isRepeatedToolName = (text: string, tool: string): boolean => text.trim() === "" || text.trim() === tool.trim();
