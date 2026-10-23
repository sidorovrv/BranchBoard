export const newId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

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

export const ownValue = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

export const unique = <T>(items: T[]): T[] => [...new Set(items)];

export const sameMembers = (left: string[], right: string[]): boolean =>
  left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item));

export const pickKeys = <T extends object, K extends keyof T>(record: T, keys: readonly K[]): Pick<T, K> =>
  Object.fromEntries(keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]])) as Pick<T, K>;

export const deriveTitle = (text: string, fallback: string): string => {
  const firstLine = text.trim().split("\n")[0] ?? "";
  if (!firstLine) return fallback;
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
};

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

export const formatDuration = (elapsedMs: number): string => {
  if (elapsedMs < MINUTE_MS) return `${(elapsedMs / SECOND_MS).toFixed(1)}s`;
  const minutes = Math.floor(elapsedMs / MINUTE_MS);
  const seconds = Math.floor((elapsedMs % MINUTE_MS) / SECOND_MS);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
};

export const formatTokens = (tokens: number): string => (tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`);

export const formatCost = (costUsd: number): string => (costUsd === 0 ? "$0.00" : costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`);

export interface Refusal {
  refusal: string;
}

export const refuse = (reason: string): Refusal => ({ refusal: reason });

export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === "object" && value !== null && "refusal" in value;
