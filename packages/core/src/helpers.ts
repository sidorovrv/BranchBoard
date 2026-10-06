export const newId = (): string => crypto.randomUUID();

export const now = (): number => Date.now();

export const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const sortBy = <T>(items: T[], ...keys: ((item: T) => number)[]): T[] =>
  [...items].sort((left, right) => {
    for (const key of keys) {
      const difference = key(left) - key(right);
      if (difference !== 0) return difference;
    }
    return 0;
  });

export const mapValues = <T, U>(record: Record<string, T>, transform: (value: T, key: string) => U): Record<string, U> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, transform(value, key)]));

export const indexBy = <T>(items: T[], key: (item: T) => string): Record<string, T> =>
  Object.fromEntries(items.map((item) => [key(item), item]));

export const unique = <T>(items: T[]): T[] => [...new Set(items)];

export const sameMembers = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((item) => right.includes(item));

export const deriveTitle = (text: string, fallback: string): string => {
  const firstLine = text.trim().split("\n")[0] ?? "";
  if (!firstLine) return fallback;
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
};

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const formatAgo = (elapsedMs: number): string => {
  if (elapsedMs < MINUTE_MS) return "just now";
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m ago`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h ago`;
  return `${Math.floor(elapsedMs / DAY_MS)}d ago`;
};

export const formatDuration = (elapsedMs: number): string => {
  if (elapsedMs < MINUTE_MS) return `${(elapsedMs / SECOND_MS).toFixed(1)}s`;
  const minutes = Math.floor(elapsedMs / MINUTE_MS);
  const seconds = Math.floor((elapsedMs % MINUTE_MS) / SECOND_MS);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
};

export const formatCountdown = (remainingMs: number): string => {
  if (remainingMs < MINUTE_MS) return "under a minute";
  if (remainingMs < HOUR_MS) return `${Math.floor(remainingMs / MINUTE_MS)} min`;
  if (remainingMs < DAY_MS) return `${Math.floor(remainingMs / HOUR_MS)} h ${Math.floor((remainingMs % HOUR_MS) / MINUTE_MS)} min`;
  return `${Math.floor(remainingMs / DAY_MS)} d ${Math.floor((remainingMs % DAY_MS) / HOUR_MS)} h`;
};

export const formatTokens = (tokens: number): string => (tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`);

export const formatCost = (costUsd: number): string => (costUsd === 0 ? "$0.00" : costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`);

export interface Refusal {
  refusal: string;
}

export const refuse = (reason: string): Refusal => ({ refusal: reason });

export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === "object" && value !== null && "refusal" in value;
