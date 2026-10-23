import { CHANNEL_SOURCE_URL, parseUpdateCheck, UPDATE_CHECK_PATH } from "../../../packages/core/src/updateCheck";
import { isDailyPayload, TELEMETRY_MAX_PAYLOAD_BYTES } from "../../../packages/core/src/telemetrySchema";

export interface Database {
  prepare: (sql: string) => { bind: (...values: unknown[]) => { run: () => Promise<unknown>; first: () => Promise<Record<string, unknown> | null> } };
}

export interface Env {
  DB: Database;
}

export const MAX_PAYLOADS_PER_DAY = 5000;

const INSERT_PAYLOAD = "INSERT OR IGNORE INTO daily (received_on, payload_id, payload_json) VALUES (?, ?, ?)";
const COUNT_DAY = "SELECT COUNT(*) AS total FROM daily WHERE received_on = ?";

export const MAX_CHECK_ROWS_PER_DAY = 5000;

const COUNT_CHECK_ROWS = "SELECT COUNT(*) AS total FROM update_checks WHERE day = ?";
const COUNT_CHECK =
  "INSERT INTO update_checks (day, version, os, arch, node, install, auto, first, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (day, version, os, arch, node, install, auto, first) DO UPDATE SET total = total + 1";

const respond = (status: number) => new Response(null, { status });

const countUpdateCheck = async (env: Env, searchParams: URLSearchParams, receivedOn: string): Promise<void> => {
  const check = parseUpdateCheck(searchParams);
  if (!check) return;
  const stored = await env.DB.prepare(COUNT_CHECK_ROWS).bind(receivedOn).first();
  if (Number(stored?.total ?? 0) >= MAX_CHECK_ROWS_PER_DAY) return;
  await env.DB.prepare(COUNT_CHECK).bind(receivedOn, check.version, check.os, check.arch, check.nodeMajor, check.install, Number(check.autoUpdate), Number(check.first)).run();
};

const answerUpdateCheck = async (url: URL, env: Env, receivedOn: string, fetchUpstream: typeof fetch): Promise<Response> => {
  const upstream = await fetchUpstream(CHANNEL_SOURCE_URL).catch(() => undefined);
  if (!upstream?.ok) return respond(502);
  const body = await upstream.text();
  await countUpdateCheck(env, url.searchParams, receivedOn).catch(() => undefined);
  return new Response(body, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
};

const readCapped = async (request: Request, limit: number): Promise<string | undefined> => {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const handleRequest = async (request: Request, env: Env, receivedOn: string = new Date().toISOString().slice(0, 10), fetchUpstream: typeof fetch = fetch): Promise<Response> => {
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method === "GET" && pathname === UPDATE_CHECK_PATH) return answerUpdateCheck(url, env, receivedOn, fetchUpstream);
  if (request.method !== "POST" || pathname !== "/v1/daily") return respond(404);
  const text = await readCapped(request, TELEMETRY_MAX_PAYLOAD_BYTES);
  if (text === undefined) return respond(413);
  const payload = parseJson(text);
  if (!isDailyPayload(payload)) return respond(400);
  const stored = await env.DB.prepare(COUNT_DAY).bind(receivedOn).first();
  if (Number(stored?.total ?? 0) >= MAX_PAYLOADS_PER_DAY) return respond(429);
  await env.DB.prepare(INSERT_PAYLOAD).bind(receivedOn, (payload as { payloadId: string }).payloadId, text).run();
  return respond(204);
};

export default { fetch: (request: Request, env: Env) => handleRequest(request, env) };
