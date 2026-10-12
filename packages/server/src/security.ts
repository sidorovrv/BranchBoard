import type { IncomingMessage } from "node:http";
import type { MiddlewareHandler } from "hono";
import { ACCESS_QUERY, accessCookieName, accessCookieHeader, cookieValueOf, tokensMatch } from "./accessToken";
import { CAPABILITY_KINDS, capabilityOfPath } from "./capabilities";
import { log } from "./log";

export interface SecurityConfig {
  port: number;
  extraOrigins: string[];
  accessToken?: string;
}

const loopbackNames = ["127.0.0.1", "localhost"];

export const allowedHosts = (config: SecurityConfig): string[] => loopbackNames.map((name) => `${name}:${config.port}`);

export const allowedOrigins = (config: SecurityConfig): string[] => [...loopbackNames.map((name) => `http://${name}:${config.port}`), ...config.extraOrigins];

const hasAccess = (config: SecurityConfig, cookieHeader: string | undefined): boolean =>
  config.accessToken === undefined || tokensMatch(config.accessToken, cookieValueOf(cookieHeader, accessCookieName(config.port)));

export const isUpgradeAllowed = (config: SecurityConfig, request: IncomingMessage): boolean =>
  allowedHosts(config).includes(request.headers.host ?? "") && allowedOrigins(config).includes(request.headers.origin ?? "") && hasAccess(config, request.headers.cookie);

const SAFE_METHODS = ["GET", "HEAD"];

export const INSTANCE_PATH = "/api/instance";

export const noFramingMiddleware: MiddlewareHandler = async (context, next) => {
  await next();
  if (capabilityOfPath(context.req.path)?.kind === "preview" && context.res.status === 200) return;
  context.res.headers.set("x-frame-options", "DENY");
  if (!context.res.headers.has("content-security-policy")) context.res.headers.set("content-security-policy", "frame-ancestors 'none'");
};

const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>Branchboard</title><body style="font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem"><h1>Branchboard is locked</h1><p>Open Branchboard with the link printed in the terminal where it was started. It contains an access key that this browser keeps afterwards.</p></body>`;

const pathWithoutAccess = (url: URL): string => {
  url.searchParams.delete(ACCESS_QUERY);
  return `/${url.pathname.replace(/^\/+/, "")}${url.search}`;
};

export const securityMiddleware = (config: SecurityConfig): MiddlewareHandler => async (context, next) => {
  const host = context.req.header("host") ?? "";
  if (!allowedHosts(config).includes(host)) {
    log.warn("security", `Rejected host "${host}" on ${context.req.method} ${context.req.path}`);
    return context.json({ error: "Host not allowed" }, 403);
  }
  const origin = context.req.header("origin") ?? "";
  const capability = capabilityOfPath(context.req.path);
  if (capability) {
    if (origin && CAPABILITY_KINDS[capability.kind].rejectsOrigin) {
      log.warn("security", `Rejected browser request with origin "${origin}" on /${capability.kind}/…`);
      return context.json({ error: "Origin not allowed" }, 403);
    }
    if (!SAFE_METHODS.includes(context.req.method) && capability.kind === "preview") return context.json({ error: "Preview is read-only" }, 405);
    return next();
  }
  if (context.req.path === INSTANCE_PATH && context.req.method === "GET") return next();
  const offered = new URL(context.req.url).searchParams.get(ACCESS_QUERY);
  if (config.accessToken !== undefined && context.req.method === "GET" && tokensMatch(config.accessToken, offered)) {
    context.header("set-cookie", accessCookieHeader(config.port, config.accessToken));
    return context.redirect(pathWithoutAccess(new URL(context.req.url)), 303);
  }
  if (!hasAccess(config, context.req.header("cookie"))) {
    log.warn("security", `Rejected request without the access key on ${context.req.method} ${context.req.path}`);
    return context.req.path.startsWith("/api/") ? context.json({ error: "Access key missing" }, 401) : context.html(LOCKED_PAGE, 401);
  }
  if (!SAFE_METHODS.includes(context.req.method) && !allowedOrigins(config).includes(origin)) {
    log.warn("security", `Rejected origin "${origin}" on ${context.req.method} ${context.req.path}`);
    return context.json({ error: "Origin not allowed" }, 403);
  }
  return next();
};
