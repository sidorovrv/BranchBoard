import { randomBytes } from "node:crypto";

export type CapabilityKind = "mcp" | "preview";

export const CAPABILITY_KINDS: Record<CapabilityKind, { rejectsOrigin: boolean }> = {
  mcp: { rejectsOrigin: true },
  preview: { rejectsOrigin: false },
};

export const PREVIEW_TTL_MS = 10 * 60 * 1000;

const SECRET_PATTERN = /^[\w-]{1,128}$/;

export interface CapabilityRequest {
  kind: CapabilityKind;
  secret: string;
  rest: string[];
}

export const capabilityOfPath = (path: string): CapabilityRequest | undefined => {
  const [, kind, secret, ...rest] = path.split("/");
  return Object.hasOwn(CAPABILITY_KINDS, kind) && secret !== undefined && SECRET_PATTERN.test(secret) ? { kind: kind as CapabilityKind, secret, rest } : undefined;
};

export const loggedPathOf = (path: string): string => {
  const capability = capabilityOfPath(path);
  return capability ? `/${capability.kind}/…/${capability.rest.join("/")}` : path;
};

interface Entry {
  kind: CapabilityKind;
  subject: string;
  ttlMs: number;
  expiresAt: number;
}

export const createCapabilityStore = (clock: () => number = Date.now) => {
  const entries = new Map<string, Entry>();

  const sweep = () => entries.forEach((entry, secret) => entry.expiresAt <= clock() && entries.delete(secret));

  const issue = (kind: CapabilityKind, subject: string, ttlMs: number): string => {
    sweep();
    const existing = [...entries.entries()].find(([, entry]) => entry.kind === kind && entry.subject === subject);
    if (existing) {
      existing[1].expiresAt = clock() + ttlMs;
      return existing[0];
    }
    const secret = randomBytes(24).toString("hex");
    entries.set(secret, { kind, subject, ttlMs, expiresAt: clock() + ttlMs });
    return secret;
  };

  const resolve = (kind: CapabilityKind, secret: string): string | undefined => {
    const entry = entries.get(secret);
    if (!entry || entry.kind !== kind) return undefined;
    if (entry.expiresAt <= clock()) return void entries.delete(secret);
    entry.expiresAt = clock() + entry.ttlMs;
    return entry.subject;
  };

  const revokeSubject = (kind: CapabilityKind, subject: string) => entries.forEach((entry, secret) => entry.kind === kind && entry.subject === subject && entries.delete(secret));

  return { issue, resolve, revokeSubject, size: () => entries.size };
};

export type CapabilityStore = ReturnType<typeof createCapabilityStore>;
