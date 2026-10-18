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

const respond = (status: number) => new Response(null, { status });

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

export const handleRequest = async (request: Request, env: Env, receivedOn: string = new Date().toISOString().slice(0, 10)): Promise<Response> => {
  const { pathname } = new URL(request.url);
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
