import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redactSecrets } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { createDiagnostics, createDiagnosticsTool, DIAGNOSTICS_TOOL_NAME } from "../packages/server/src/diagnostics";
import { createApprovalBroker } from "../packages/server/src/runtimes/claudeApprovals";
import { createClaudeRuntime } from "../packages/server/src/runtimes/claude";

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "bb-diagnostics-"));
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });

const makeDiagnostics = (settings: Record<string, unknown> = {}) => {
  const dataDirectory = mkdtempSync(join(directory, "data-"));
  const settingsFile = join(dataDirectory, "settings.json");
  writeFileSync(settingsFile, JSON.stringify(settings));
  mkdirSync(join(dataDirectory, "run-logs"));
  const records = [
    { event: "start", boardId: "b1", nodeId: "n1", roll: 1, prompt: "typed prompt", input: "secret prompt" },
    { event: "end", boardId: "b1", nodeId: "n1", roll: 1, errors: [] },
    { event: "end", boardId: "b2", nodeId: "n9", roll: 1, errors: ["boom sk-ant-abcdefgh12345678"] },
  ];
  writeFileSync(join(dataDirectory, "run-logs", "b1.jsonl"), records.map((record) => JSON.stringify(record)).join("\n"));
  const diagnostics = createDiagnostics({
    dataDirectory,
    version: "9.9.9",
    settingsFile,
    channelStatus: () => ({ fetchedAt: 1, checkedAt: 2, error: null, isOffline: false }),
    runtimes: async () => [{ id: "claude", detail: "found claude 2.9.9 at /home/me/bin" }],
    models: async () => [{ runtime: "claude", models: [{ id: "sonnet", source: "alias" }] }],
    redaction: () => ({ secrets: ["hunter2-secret"], homeDirectory: "/home/me" }),
  });
  return { diagnostics, dataDirectory };
};

describe("diagnostics collector", () => {
  it("redacts every section", async () => {
    const { diagnostics, dataDirectory } = makeDiagnostics({ note: "hunter2-secret" });
    expect(JSON.stringify(await diagnostics.collect("settings"))).not.toContain("hunter2-secret");
    expect(JSON.stringify(await diagnostics.collect("runs"))).not.toContain("sk-ant-abcdefgh12345678");
    expect(JSON.stringify(await diagnostics.collect("runtimes"))).not.toContain("/home/me");
    expect(await diagnostics.collect("about")).toMatchObject({ version: "9.9.9", dataDirectory });
    expect(await diagnostics.collect("models")).toMatchObject({ runtimes: [{ models: [{ source: "alias" }] }], channel: { fetchedAt: 1, checkedAt: 2 } });
  });

  it("drops prompts from run records and filters by text", async () => {
    const { diagnostics } = makeDiagnostics();
    const all = (await diagnostics.collect("runs")) as Record<string, unknown>[];
    expect(all).toHaveLength(3);
    expect(all.every((record) => !("input" in record) && !("prompt" in record))).toBe(true);
    expect(await diagnostics.collect("runs", { filter: "n9" })).toHaveLength(1);
  });

  it("limits runs to the calling node when cross-node access is off", async () => {
    const caller = { boardId: "b1", nodeId: "n1" };
    const on = makeDiagnostics({ agentCrossNodeLogs: true });
    expect(await on.diagnostics.collect("runs", { caller })).toHaveLength(3);
    const off = makeDiagnostics({ agentCrossNodeLogs: false });
    const scoped = (await off.diagnostics.collect("runs", { caller })) as Record<string, unknown>[];
    expect(scoped.map((record) => record.nodeId)).toEqual(["n1", "n1"]);
    expect(await off.diagnostics.collect("runs")).toHaveLength(3);
  });

  it("reads the toggle at call time", () => {
    const { diagnostics, dataDirectory } = makeDiagnostics();
    expect(diagnostics.isAgentAccessOn()).toBe(true);
    writeFileSync(join(dataDirectory, "settings.json"), JSON.stringify({ agentDiagnosticsAccess: false }));
    expect(diagnostics.isAgentAccessOn()).toBe(false);
  });
});

describe("diagnostics MCP tool", () => {
  const callTool = (broker: ReturnType<typeof createApprovalBroker>, secret: string, args: Record<string, unknown>) =>
    broker.handle(secret, rpc("tools/call", { name: DIAGNOSTICS_TOOL_NAME, arguments: args })).then((reply) => (reply.body as any).result);

  it("is listed and callable only while the toggle is on", async () => {
    const { diagnostics, dataDirectory } = makeDiagnostics();
    const broker = createApprovalBroker();
    const { secret } = broker.register(async () => ({ behavior: "deny", message: "no" }), [createDiagnosticsTool(diagnostics, { boardId: "b1", nodeId: "n1" })]);
    const names = async () => ((await broker.handle(secret, rpc("tools/list"))).body as any).result.tools.map((tool: any) => tool.name);
    expect(await names()).toEqual(["approve", DIAGNOSTICS_TOOL_NAME]);
    const result = await callTool(broker, secret, { section: "about" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ version: "9.9.9" });
    writeFileSync(join(dataDirectory, "settings.json"), JSON.stringify({ agentDiagnosticsAccess: false }));
    expect(await names()).toEqual(["approve"]);
    const refused = (await broker.handle(secret, rpc("tools/call", { name: DIAGNOSTICS_TOOL_NAME, arguments: { section: "about" } }))).body as any;
    expect(refused.error.code).toBe(-32602);
  });

  it("reports an unknown section as a tool error", async () => {
    const { diagnostics } = makeDiagnostics();
    const broker = createApprovalBroker();
    const { secret } = broker.register(async () => ({ behavior: "deny", message: "no" }), [createDiagnosticsTool(diagnostics, { boardId: "b1", nodeId: "n1" })]);
    const result = await callTool(broker, secret, { section: "nope" });
    expect(result.isError).toBe(true);
  });
});

describe("model sources and route", () => {
  it("tags each claude catalog model with its source", async () => {
    const runtime = createClaudeRuntime({
      serverUrl: "http://x",
      locate: () => ({ path: "claude", searched: [] }),
      probeVersion: async () => "2.9.9",
      probeModels: async () => [{ id: "claude-cli-1", name: "Cli 1" }],
      extraModels: () => [
        { id: "claude-channel-1", name: "Channel 1", source: "channel" },
        { id: "claude-seen-1", name: "Seen 1", source: "seen" },
      ],
    });
    const { models } = await runtime.catalog(directory);
    const sourceOf = (id: string) => models.find((model) => model.id === id)?.source;
    expect([sourceOf("claude-cli-1"), sourceOf("sonnet"), sourceOf("claude-channel-1"), sourceOf("claude-seen-1")]).toEqual(["cli", "alias", "channel", "seen"]);
  });

  it("serves /api/diagnostics and refuses unknown sections", async () => {
    const dataDirectory = mkdtempSync(join(directory, "route-"));
    const server = createApp({ databasePath: join(dataDirectory, "t.db"), security: { port: 47303, extraOrigins: [] } });
    const headers = { host: "127.0.0.1:47303", origin: "http://127.0.0.1:47303" };
    const about = await server.app.request("http://127.0.0.1:47303/api/diagnostics?section=about", { headers });
    expect(await about.json()).toMatchObject({ dataDirectory: redactSecrets(dataDirectory, { homeDirectory: homedir() }) });
    expect((await server.app.request("http://127.0.0.1:47303/api/diagnostics?section=nope", { headers })).status).toBe(409);
    server.close();
  });
});
