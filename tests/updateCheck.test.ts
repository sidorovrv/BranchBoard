import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CHANNEL_SOURCE_URL, parseUpdateCheck, sendableUpdateCheckQuery, updateCheckQuery, type UpdateCheck } from "@branchboard/core";
import { CHANNEL_URL, TAGS_URL, UPDATE_CHECK_URL, createRemoteChannel, type UpdateCheckFacts } from "../packages/server/src/channel";
import { handleRequest, MAX_CHECK_ROWS_PER_DAY, type Env } from "../services/telemetry-worker/src/index";

const directory = mkdtempSync(join(tmpdir(), "branchboard-update-check-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const check: UpdateCheck = { version: "0.3.0", os: "win32", arch: "x64", nodeMajor: 24, install: "npm", autoUpdate: true, first: false };
const facts: UpdateCheckFacts = { version: "0.3.0", os: "win32", arch: "x64", nodeMajor: 24, install: "npm", autoUpdate: true };
const channelText = JSON.stringify({ minimumVersion: "0.1.5", claudeModels: [] });
const tagsText = JSON.stringify({ latest: "0.3.0" });
const DAY = 25 * 60 * 60 * 1000;

describe("update check parameters", () => {
  it("round-trips a valid check", () => {
    expect(parseUpdateCheck(new URLSearchParams(updateCheckQuery(check)))).toEqual(check);
  });

  it("rejects values outside the fixed lists and extra shapes", () => {
    const rejected = [
      { ...check, os: "templeos" },
      { ...check, arch: "x86_64" },
      { ...check, install: "source" },
      { ...check, version: "development" },
      { ...check, nodeMajor: 12345 },
    ];
    rejected.forEach((candidate) => expect(sendableUpdateCheckQuery(candidate)).toBeUndefined());
    expect(parseUpdateCheck(new URLSearchParams("v=0.3.0"))).toBeUndefined();
    expect(parseUpdateCheck(new URLSearchParams(updateCheckQuery(check).replace("auto=1", "auto=2")))).toBeUndefined();
  });
});

describe("update check on the channel", () => {
  const sourceOf = (calls: string[]) => async (url: string) => {
    calls.push(url);
    return url === TAGS_URL ? tagsText : channelText;
  };

  it("asks the service with the facts, marks the first check, and sends one check a day", async () => {
    const dataDirectory = mkdtempSync(join(directory, "first-"));
    const calls: string[] = [];
    let time = Date.UTC(2026, 9, 20, 12);
    const channel = createRemoteChannel({ dataDirectory, updateCheckFacts: () => facts, isOffline: () => false, fetchText: sourceOf(calls), clock: () => time });
    await channel.refresh();
    expect(calls.filter((url) => url.startsWith(UPDATE_CHECK_URL))).toEqual([`${UPDATE_CHECK_URL}?${updateCheckQuery({ ...facts, first: true })}`]);
    expect(calls).not.toContain(CHANNEL_URL);
    calls.length = 0;
    await channel.refresh({ force: true });
    expect(calls).toEqual(expect.arrayContaining([TAGS_URL, CHANNEL_URL]));
    expect(calls.some((url) => url.startsWith(UPDATE_CHECK_URL))).toBe(false);
    calls.length = 0;
    time += DAY;
    await channel.refresh();
    expect(calls).toContain(`${UPDATE_CHECK_URL}?${updateCheckQuery({ ...facts, first: false })}`);
  });

  it("falls back to the channel file without parameters and repeats the first flag until the service answers", async () => {
    const dataDirectory = mkdtempSync(join(directory, "fallback-"));
    const calls: string[] = [];
    let isServiceDown = true;
    const fetchText = async (url: string) => {
      if (url.startsWith(UPDATE_CHECK_URL) && isServiceDown) throw new Error("down");
      return sourceOf(calls)(url);
    };
    const channel = createRemoteChannel({ dataDirectory, updateCheckFacts: () => facts, isOffline: () => false, fetchText, clock: () => 1_000_000 });
    await channel.refresh();
    expect(channel.status().error).toBeNull();
    isServiceDown = false;
    await channel.refresh({ force: true });
    expect(calls).toContain(`${UPDATE_CHECK_URL}?${updateCheckQuery({ ...facts, first: true })}`);
  });

  it("sends nothing for a dev build, offline, or a local channel file", async () => {
    const calls: string[] = [];
    const run = async (name: string, options: Parameters<typeof createRemoteChannel>[0]) => createRemoteChannel({ ...options, dataDirectory: mkdtempSync(join(directory, name)), fetchText: sourceOf(calls) }).refresh();
    await run("dev-", { dataDirectory: "", updateCheckFacts: () => undefined, isOffline: () => false });
    await run("offline-", { dataDirectory: "", updateCheckFacts: () => facts, isOffline: () => true });
    expect(calls.filter((url) => url.startsWith(UPDATE_CHECK_URL))).toEqual([]);
    expect(calls).toContain(CHANNEL_URL);
  });
});

const fakeDatabase = () => {
  const rows = new Map<string, number>();
  const env: Env = {
    DB: {
      prepare: (sql) => ({
        bind: (...values) => ({
          run: async () => {
            const key = values.slice(0, 8).join("|");
            rows.set(key, (rows.get(key) ?? 0) + 1);
          },
          first: async () => ({ total: sql.includes("update_checks") ? [...rows.keys()].filter((key) => key.startsWith(`${values[0]}|`)).length : 0 }),
        }),
      }),
    },
  };
  return { env, rows };
};

const upstreamOf = (status = 200): typeof fetch => (async (input: RequestInfo | URL) => (String(input) === CHANNEL_SOURCE_URL ? new Response(channelText, { status }) : new Response(null, { status: 404 }))) as typeof fetch;

const get = (query: string) => new Request(`https://worker.example/v1/channel?${query}`);

describe("update check on the worker", () => {
  it("returns the channel file and counts the check per day and facts", async () => {
    const { env, rows } = fakeDatabase();
    const query = updateCheckQuery(check);
    const response = await handleRequest(get(query), env, "2026-10-20", upstreamOf());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(channelText);
    await handleRequest(get(query), env, "2026-10-20", upstreamOf());
    expect([...rows]).toEqual([["2026-10-20|0.3.0|win32|x64|24|npm|1|0", 2]]);
  });

  it("returns the channel file without counting an invalid or empty query", async () => {
    const { env, rows } = fakeDatabase();
    expect((await handleRequest(get("v=0.3.0&os=templeos"), env, "2026-10-20", upstreamOf())).status).toBe(200);
    expect((await handleRequest(get(""), env, "2026-10-20", upstreamOf())).status).toBe(200);
    expect(rows.size).toBe(0);
  });

  it("answers 502 when GitHub does not answer, and stops adding rows above the daily cap", async () => {
    const { env, rows } = fakeDatabase();
    expect((await handleRequest(get(updateCheckQuery(check)), env, "2026-10-20", upstreamOf(500))).status).toBe(502);
    expect(rows.size).toBe(0);
    for (let index = 0; index < MAX_CHECK_ROWS_PER_DAY; index++) rows.set(`2026-10-20|filler${index}`, 1);
    expect((await handleRequest(get(updateCheckQuery(check)), env, "2026-10-20", upstreamOf())).status).toBe(200);
    expect(rows.size).toBe(MAX_CHECK_ROWS_PER_DAY);
  });
});
