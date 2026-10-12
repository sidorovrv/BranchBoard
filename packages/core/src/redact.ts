const REDACTED = "[redacted]";
const MIN_SECRET_CHARS = 6;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*KEY-----[\s\S]*?(?:-----END [A-Z ]*KEY-----|$)/g,
  /sk-ant-[\w-]{8,}/g,
  /sk-[\w-]{16,}/g,
  /gh[pousr]_\w{20,}/g,
  /github_pat_\w{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /Bearer\s+[\w.~+/=-]{8,}/gi,
  /([?&]access=)[^&\s"']+/g,
];

const escapeForPattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface RedactionContext {
  secrets?: string[];
  homeDirectory?: string;
}

export const redactSecrets = (text: string, { secrets = [], homeDirectory }: RedactionContext = {}): string => {
  const literals = secrets.filter((secret) => secret.length >= MIN_SECRET_CHARS).sort((a, b) => b.length - a.length);
  const withoutLiterals = literals.reduce((current, secret) => current.replace(new RegExp(escapeForPattern(secret), "g"), REDACTED), text);
  const withoutPatterns = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (_match, prefix) => (typeof prefix === "string" ? `${prefix}${REDACTED}` : REDACTED)),
    withoutLiterals,
  );
  if (!homeDirectory || homeDirectory.length < 2) return withoutPatterns;
  const separators = "[\\\\/]";
  const homePattern = escapeForPattern(homeDirectory).replace(/\\\\|\//g, separators);
  return withoutPatterns.replace(new RegExp(homePattern, "gi"), "~");
};

export const redactDeep = <T>(value: T, context: RedactionContext = {}): T => {
  if (typeof value === "string") return redactSecrets(value, context) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, context)) as T;
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, context)])) as T;
  return value;
};

export const SENSITIVE_COMMANDS: ReadonlySet<string> = new Set(["setCredential"]);

const SUMMARISED_KEYS = ["type", "boardId", "projectId", "nodeId", "nodeIds", "runtimeId"];

export const summariseCommand = (command: Record<string, unknown>): Record<string, unknown> => ({
  ...Object.fromEntries(SUMMARISED_KEYS.filter((key) => key in command).map((key) => [key, command[key]])),
  fields: Object.keys(command).filter((key) => !SUMMARISED_KEYS.includes(key)),
});
