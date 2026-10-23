import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installCommandFor, isApiRuntime, isNewerVersion, isRuntimeId, RUNTIME_IDS, RUNTIMES } from "@branchboard/core";
import { runtimeSummary } from "../packages/cli/src/run";
import { createApp } from "../packages/server/src/app";
import { CHANNEL_URL, TAGS_URL, createRemoteChannel, parseChannel, parseTags } from "../packages/server/src/channel";
import { dataDirectoryId } from "../packages/server/src/dataDirectory";
import { DEFAULT_ENGINE_VERSION } from "../packages/server/src/engine/locator";
import { createClaudeRuntime } from "../packages/server/src/runtimes/claude";
import { pickFreePort, readLastPort, resolvePort, writeLastPort, type PortState } from "../packages/cli/src/ports";
import { parseArguments } from "../packages/cli/src/args";

const directory = mkdtempSync(join(tmpdir(), "branchboard-distribution-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const probeOf = (states: Record<number, PortState>) => async (port: number): Promise<PortState> => states[port] ?? { kind: "free" };

describe("choosing a port", () => {
  const ours = dataDirectoryId("/data/a");

  const pickPort = async () => 51234;

  it("asks the system for a port when nothing was requested or remembered", async () => {
    expect(await resolvePort({ dataDirId: ours, probe: probeOf({}), pickPort })).toEqual({ kind: "start", port: 51234 });
  });

  it("starts on the remembered port when nothing answers there, so the browser keeps its stored settings", async () => {
    expect(await resolvePort({ lastPort: 4000, dataDirId: ours, probe: probeOf({}), pickPort })).toEqual({ kind: "start", port: 4000 });
  });

  it("picks a new port when the remembered one is taken by another program or by another data folder", async () => {
    const other = { kind: "branchboard" as const, dataDirId: dataDirectoryId("/data/b") };
    expect(await resolvePort({ lastPort: 4000, dataDirId: ours, probe: probeOf({ 4000: { kind: "busy" } }), pickPort })).toEqual({ kind: "start", port: 51234 });
    expect(await resolvePort({ lastPort: 4000, dataDirId: ours, probe: probeOf({ 4000: other }), pickPort })).toEqual({ kind: "start", port: 51234 });
  });

  it("reuses the remembered port while an instance on the same data folder answers there", async () => {
    const probe = probeOf({ 4000: { kind: "branchboard", dataDirId: ours } });
    expect(await resolvePort({ lastPort: 4000, dataDirId: ours, probe, pickPort })).toEqual({ kind: "reuse", port: 4000 });
  });

  it("uses only the requested port when it was given", async () => {
    expect(await resolvePort({ requestedPort: 5000, lastPort: 4000, dataDirId: ours, probe: probeOf({}), pickPort })).toEqual({ kind: "start", port: 5000 });
    expect(await resolvePort({ requestedPort: 5000, dataDirId: ours, probe: probeOf({ 5000: { kind: "busy" } }), pickPort })).toEqual({ kind: "none" });
    expect(await resolvePort({ requestedPort: 5000, dataDirId: ours, probe: probeOf({ 5000: { kind: "branchboard", dataDirId: ours } }), pickPort })).toEqual({ kind: "reuse", port: 5000 });
  });

  it("remembers the port in a file and gets a usable free port from the system", async () => {
    const file = join(directory, "port");
    expect(readLastPort(file)).toBeUndefined();
    writeLastPort(file, 4321);
    expect(readLastPort(file)).toBe(4321);
    writeFileSync(file, "junk");
    expect(readLastPort(file)).toBeUndefined();
    expect(await pickFreePort()).toBeGreaterThan(0);
  });

  it("reads --no-auto-update", () => {
    expect(parseArguments([])).toMatchObject({ shouldAutoUpdate: true });
    expect(parseArguments(["--no-auto-update"])).toMatchObject({ kind: "run", shouldAutoUpdate: false });
  });

  it("reads --offline", () => {
    expect(parseArguments(["--offline"])).toMatchObject({ kind: "run", offline: true });
  });
});

describe("runtime registry and start summary", () => {
  it("lists every runtime with a kind, and API runtimes with an address policy", () => {
    expect(RUNTIME_IDS.sort()).toEqual(["anthropic", "claude", "codex", "fake", "openai", "opencode", "opencode2"]);
    expect(RUNTIMES.anthropic.credential.baseUrlEditable).toBe(true);
    expect(RUNTIMES.openai.credential.baseUrlEditable).toBe(true);
    expect(isApiRuntime("openai")).toBe(true);
    expect(isApiRuntime("claude")).toBe(false);
    expect(isRuntimeId("constructor")).toBe(false);
  });

  it("prints only the commands that were found", () => {
    const summary = runtimeSummary({ opencode: () => ({ path: "C:\\bin\\opencode.cmd" }), claude: () => ({}), codex: () => ({}) });
    expect(summary).toEqual(["OpenCode: found (C:\\bin\\opencode.cmd)"]);
    expect(installCommandFor("claude", "darwin")).toBe("npm install -g @anthropic-ai/claude-code");
    expect(installCommandFor("anthropic", "linux")).toBeUndefined();
  });

  it("points to the setup guide when no command was found", () => {
    expect(runtimeSummary({ claude: () => ({}), codex: () => ({}) })).toEqual(["No claude, codex or opencode command was found. The setup guide in the browser shows how to install one."]);
  });
});

describe("instance route", () => {
  it("answers without the access key and names the data folder", async () => {
    const dataDirectory = mkdtempSync(join(directory, "instance-"));
    const server = createApp({ databasePath: join(dataDirectory, "t.db"), security: { port: 47301, extraOrigins: [], accessToken: "a".repeat(64) } });
    const headers = { host: "127.0.0.1:47301" };
    const instance = await server.app.request("http://127.0.0.1:47301/api/instance", { headers });
    expect(await instance.json()).toEqual({ app: "branchboard", dataDirId: dataDirectoryId(dataDirectory) });
    expect((await server.app.request("http://127.0.0.1:47301/api/boards", { headers })).status).toBe(401);
    server.close();
  });
});

describe("update channel", () => {
  const channelText = JSON.stringify({ minimumVersion: "0.1.5", claudeModels: [{ id: "claude-new-1", name: "New 1" }, { id: "bad id", name: "x" }] });
  const tagsText = JSON.stringify({ latest: "0.3.0", next: "0.4.0-next.1" });
  const fresh = async (url: string) => (url === TAGS_URL ? tagsText : channelText);

  it("keeps only well-formed entries", () => {
    expect(parseChannel(JSON.parse(channelText))).toEqual({ tags: {}, minimumVersion: "0.1.5", claudeModels: [{ id: "claude-new-1", name: "New 1" }] });
    expect(parseTags(JSON.parse(tagsText))).toEqual({ latest: "0.3.0" });
    expect(parseTags({ latest: "soon" })).toEqual({});
    expect(parseChannel("nonsense")).toEqual({ tags: {}, minimumVersion: undefined, claudeModels: [] });
  });

  it("pins the engine version the server falls back to", () => {
    const published = parseChannel(JSON.parse(readFileSync(join(import.meta.dirname, "..", "channel.json"), "utf8")));
    expect(published.engine?.version).toBe(DEFAULT_ENGINE_VERSION);
  });

  it("compares versions, pre-releases included", () => {
    expect(isNewerVersion("0.2.1", "0.2.0")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.2.0", "development")).toBe(false);
    expect(isNewerVersion("0.3.0", "0.3.0-next.2")).toBe(true);
    expect(isNewerVersion("0.3.0-next.2", "0.3.0")).toBe(false);
    expect(isNewerVersion("0.3.0-next.10", "0.3.0-next.9")).toBe(true);
    expect(isNewerVersion("0.3.0-next.1", "0.2.9")).toBe(true);
  });

  it("fetches at most once a day unless forced, and never when offline", async () => {
    const dataDirectory = mkdtempSync(join(directory, "channel-"));
    let calls = 0;
    let time = 1_000_000;
    const make = (isOffline: boolean) => createRemoteChannel({ dataDirectory, isOffline: () => isOffline, fetchText: async (url) => (calls++, fresh(url)), clock: () => time });
    await make(true).refresh();
    expect(calls).toBe(0);
    await make(false).refresh();
    await make(false).refresh();
    expect(calls).toBe(2);
    expect(make(false).contents().tags.latest).toBe("0.3.0");
    expect(make(false).status()).toMatchObject({ checkedAt: time, error: null });
    await make(false).refresh({ force: true });
    expect(calls).toBe(4);
    time += 25 * 60 * 60 * 1000;
    await make(false).refresh();
    expect(calls).toBe(6);
  });

  it("keeps the old contents and reports the error when fetches fail", async () => {
    const dataDirectory = mkdtempSync(join(directory, "channel-fail-"));
    let time = 1;
    let shouldFail = false;
    const channel = createRemoteChannel({ dataDirectory, isOffline: () => false, fetchText: async (url) => { if (shouldFail) throw new Error("down"); return fresh(url); }, clock: () => time });
    await channel.refresh();
    shouldFail = true;
    time += 25 * 60 * 60 * 1000;
    await channel.refresh();
    expect(channel.contents().tags.latest).toBe("0.3.0");
    expect(channel.status()).toMatchObject({ checkedAt: 1, error: "down" });
  });

  it("does not report an error when only channel.json fails", async () => {
    const dataDirectory = mkdtempSync(join(directory, "channel-partial-"));
    const channel = createRemoteChannel({ dataDirectory, isOffline: () => false, fetchText: async (url) => { if (url === CHANNEL_URL) throw new Error("HTTP 404"); return tagsText; } });
    await channel.refresh();
    expect(channel.contents().tags.latest).toBe("0.3.0");
    expect(channel.status()).toMatchObject({ checkedAt: expect.any(Number), error: null });
  });

  it("reports the error and keeps the fetched model file when only the npm check fails", async () => {
    const dataDirectory = mkdtempSync(join(directory, "channel-npm-down-"));
    const channel = createRemoteChannel({ dataDirectory, isOffline: () => false, fetchText: async (url) => { if (url === TAGS_URL) throw new Error("HTTP 500"); return channelText; } });
    await channel.refresh();
    expect(channel.contents().claudeModels).toEqual([{ id: "claude-new-1", name: "New 1" }]);
    expect(channel.status().error).toBe("HTTP 500");
  });

  it("reads a local channel file when BRANCHBOARD_CHANNEL_FILE is set, on every refresh", async () => {
    const dataDirectory = mkdtempSync(join(directory, "channel-file-"));
    const file = join(dataDirectory, "dev-channel.json");
    writeFileSync(file, JSON.stringify({ tags: { latest: "5.0.0" }, minimumVersion: "1.0.0" }));
    process.env.BRANCHBOARD_CHANNEL_FILE = file;
    try {
      const channel = createRemoteChannel({ dataDirectory, isOffline: () => false });
      await channel.refresh();
      expect(channel.contents()).toMatchObject({ tags: { latest: "5.0.0" }, minimumVersion: "1.0.0" });
      writeFileSync(file, JSON.stringify({ tags: { latest: "6.0.0" } }));
      await channel.refresh();
      expect(channel.contents().tags.latest).toBe("6.0.0");
    } finally {
      delete process.env.BRANCHBOARD_CHANNEL_FILE;
    }
  });

  it("records model ids it has seen, once each, and ignores odd ones", () => {
    const dataDirectory = mkdtempSync(join(directory, "seen-"));
    const channel = createRemoteChannel({ dataDirectory });
    ["claude-x-1", "claude-x-1", "no way"].forEach(channel.recordSeenModel);
    expect(channel.seenModels()).toEqual([{ id: "claude-x-1", name: "claude-x-1" }]);
    expect(JSON.parse(readFileSync(join(dataDirectory, "models-seen.json"), "utf8"))).toEqual(["claude-x-1"]);
  });

  it("adds channel and seen models to the claude catalog without duplicates", async () => {
    const runtime = createClaudeRuntime({
      serverUrl: "http://x",
      locate: () => ({ path: "claude", searched: [] }),
      probeVersion: async () => "2.9.9",
      extraModels: () => [{ id: "claude-new-1", name: "New 1" }, { id: "sonnet", name: "Duplicate" }, { id: "claude-new-1", name: "Again" }],
    });
    const { models } = await runtime.catalog(directory);
    expect(models.filter((model) => model.id === "claude-new-1")).toHaveLength(1);
    expect(models.filter((model) => model.id === "sonnet")).toHaveLength(1);
  });
});

describe("data folder commands and about route", () => {
  it("reports the version and clears logs through a command", async () => {
    const dataDirectory = mkdtempSync(join(directory, "about-"));
    mkdirSync(join(dataDirectory, "run-logs"));
    writeFileSync(join(dataDirectory, "run-logs", "b.jsonl"), "{}");
    const server = createApp({ databasePath: join(dataDirectory, "t.db"), security: { port: 47302, extraOrigins: [] } });
    const headers = { host: "127.0.0.1:47302", origin: "http://127.0.0.1:47302", "content-type": "application/json" };
    const about = await (await server.app.request("http://127.0.0.1:47302/api/about", { headers })).json();
    expect(about).toMatchObject({ dataDirectory, update: null });
    await server.app.request("http://127.0.0.1:47302/api/commands", { method: "POST", headers: { ...headers, "x-command-type": "clearLogs" }, body: JSON.stringify({ type: "clearLogs" }) });
    expect(existsSync(join(dataDirectory, "run-logs"))).toBe(false);
    server.close();
  });
});
