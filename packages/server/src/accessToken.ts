import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const ACCESS_COOKIE = "branchboard_access";
export const ACCESS_QUERY = "access";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export const loadAccessToken = (path: string): string => {
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (TOKEN_PATTERN.test(stored)) return stored;
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  return token;
};

const digestOf = (value: string): Buffer => createHash("sha256").update(value).digest();

export const tokensMatch = (expected: string, offered: string | undefined | null): boolean => offered !== undefined && offered !== null && timingSafeEqual(digestOf(expected), digestOf(offered));

export const cookieValueOf = (header: string | undefined, name: string): string | undefined =>
  header
    ?.split(";")
    .map((pair) => pair.trim().split("="))
    .find(([key]) => key === name)?.[1];

export const accessCookieHeader = (token: string): string => `${ACCESS_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ONE_YEAR_SECONDS}`;

export const accessLinkOf = (port: number, token: string): string => `http://127.0.0.1:${port}/?${ACCESS_QUERY}=${token}`;
