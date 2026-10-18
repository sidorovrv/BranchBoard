import { describe, expect, it } from "vitest";
import { buildDailyPayload, type TelemetryFacts } from "@branchboard/core";
import { handleRequest, MAX_PAYLOADS_PER_DAY, type Env } from "../services/telemetry-worker/src/index";

const facts: TelemetryFacts = {
  payloadId: "0b4c2f3e-52a1-4c7e-9d64-1f0a8d3c5b21",
  version: "0.3.0",
  os: "win32",
  nodeMajor: 24,
  boardsTotal: 2,
  branching: { maxDepth: 1, maxChildren: 2, avgChildren: 1.5 },
};

const payload = JSON.stringify(buildDailyPayload("2026-10-16", { firstDay: "2026-10-01", days: {} }, facts));

const fakeEnv = () => {
  const rows = new Map<string, { receivedOn: string; json: string }>();
  const env: Env = {
    DB: {
      prepare: () => ({
        bind: (receivedOn, payloadId, json) => ({
          run: async () => {
            if (!rows.has(payloadId as string)) rows.set(payloadId as string, { receivedOn: receivedOn as string, json: json as string });
          },
          first: async () => ({ total: [...rows.values()].filter((row) => row.receivedOn === receivedOn).length }),
        }),
      }),
    },
  };
  return { env, rows };
};

const post = (body: string, path = "/v1/daily", method = "POST") => new Request(`https://worker.example${path}`, { method, body: method === "POST" ? body : undefined });

describe("telemetry worker", () => {
  it("stores a valid payload with the receive date and answers 204", async () => {
    const { env, rows } = fakeEnv();
    const response = await handleRequest(post(payload), env, "2026-10-17");
    expect(response.status).toBe(204);
    expect([...rows.values()]).toEqual([{ receivedOn: "2026-10-17", json: payload }]);
  });

  it("ignores a repeated payload id", async () => {
    const { env, rows } = fakeEnv();
    await handleRequest(post(payload), env, "2026-10-17");
    expect((await handleRequest(post(payload), env, "2026-10-18")).status).toBe(204);
    expect(rows.size).toBe(1);
    expect([...rows.values()][0].receivedOn).toBe("2026-10-17");
  });

  it("answers 429 and stores nothing once the day holds the maximum number of payloads", async () => {
    const { env, rows } = fakeEnv();
    for (let index = 0; index < MAX_PAYLOADS_PER_DAY; index += 1) rows.set(`id-${index}`, { receivedOn: "2026-10-17", json: "{}" });
    expect((await handleRequest(post(payload), env, "2026-10-17")).status).toBe(429);
    expect(rows.size).toBe(MAX_PAYLOADS_PER_DAY);
    expect((await handleRequest(post(payload), env, "2026-10-18")).status).toBe(204);
    expect(rows.size).toBe(MAX_PAYLOADS_PER_DAY + 1);
  });

  it("rejects text that is not JSON, a wrong shape and an unknown field", async () => {
    const { env, rows } = fakeEnv();
    expect((await handleRequest(post("not json"), env)).status).toBe(400);
    expect((await handleRequest(post(JSON.stringify({ schema: 1 })), env)).status).toBe(400);
    expect((await handleRequest(post(JSON.stringify({ ...JSON.parse(payload), prompt: "text" })), env)).status).toBe(400);
    expect(rows.size).toBe(0);
  });

  it("rejects a body above 8 KB", async () => {
    const { env, rows } = fakeEnv();
    expect((await handleRequest(post(JSON.stringify({ ...JSON.parse(payload), padding: "x".repeat(9000) })), env)).status).toBe(413);
    expect(rows.size).toBe(0);
  });

  it("answers 404 for any other path or method", async () => {
    const { env } = fakeEnv();
    expect((await handleRequest(post(payload, "/"), env)).status).toBe(404);
    expect((await handleRequest(post(payload, "/v1/daily", "GET"), env)).status).toBe(404);
    expect((await handleRequest(post(payload, "/v1/daily/extra"), env)).status).toBe(404);
  });
});
