import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  COMMAND_TYPE_HEADER,
  migrateDocumentWith,
  SCHEMA_STEPS,
  summariseCommand,
  type BoardDocument,
  type GraphNode,
  type SchemaStep,
} from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { BODY_CAPS, readCappedBody } from "../packages/server/src/bodies";
import { openRepository } from "../packages/server/src/db";
import { clearLogs } from "../packages/server/src/logSources";

const directory = mkdtempSync(join(tmpdir(), "branchboard-foundations-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });

const requestOf = (chunks: Uint8Array[], headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1/", { method: "POST", body: streamOf(chunks), headers, duplex: "half" } as RequestInit);

describe("capped request bodies", () => {
  it("reads json and bytes under the cap", async () => {
    const encoded = new TextEncoder().encode('{"a":1}');
    expect(await readCappedBody(requestOf([encoded]), 100, "json")).toEqual({ a: 1 });
    expect(await readCappedBody(requestOf([encoded.slice(0, 3), encoded.slice(3)]), 100, "bytes")).toEqual(encoded);
  });

  it("stops at the cap whatever content-length says", async () => {
    const chunk = new Uint8Array(600);
    await expect(readCappedBody(requestOf([chunk, chunk], { "content-length": "10" }), 1000, "bytes")).rejects.toThrow(/larger than/);
  });

  it("refuses an oversized command and lets an import use its own cap", async () => {
    const dataDirectory = mkdtempSync(join(directory, "app-"));
    const server = createApp({ databasePath: join(dataDirectory, "t.db"), security: { port: 47199, extraOrigins: [] } });
    const headers = { host: "127.0.0.1:47199", origin: "http://127.0.0.1:47199", "content-type": "application/json" };
    const padding = "x".repeat(BODY_CAPS.commands + 10);
    const send = (type: string, extra: Record<string, string> = {}) =>
      server.app.request("http://127.0.0.1:47199/api/commands", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ type, padding }) });
    expect((await send("createBoard")).status).toBe(409);
    const imported = await send("importBoard", { [COMMAND_TYPE_HEADER]: "importBoard" });
    expect(((await imported.json()) as { error: string }).error).not.toMatch(/larger than/);
    const bigSample = await server.app.request("http://127.0.0.1:47199/api/perf", { method: "POST", headers, body: "y".repeat(BODY_CAPS.perf + 1) });
    expect(bigSample.status).toBe(409);
    server.close();
  });

  it("keeps the settings in the data folder", async () => {
    const dataDirectory = mkdtempSync(join(directory, "settings-"));
    const databasePath = join(dataDirectory, "t.db");
    const headers = { host: "127.0.0.1:47199", origin: "http://127.0.0.1:47199", "content-type": "application/json" };
    const url = "http://127.0.0.1:47199/api/settings";
    const first = createApp({ databasePath, security: { port: 47199, extraOrigins: [] } });
    expect(await (await first.app.request(url, { headers })).json()).toBeNull();
    expect((await first.app.request(url, { method: "PUT", headers, body: JSON.stringify({ theme: "dark" }) })).status).toBe(204);
    expect((await first.app.request(url, { method: "PUT", headers, body: JSON.stringify([1]) })).status).toBe(409);
    first.close();
    const second = createApp({ databasePath, security: { port: 47199, extraOrigins: [] } });
    expect(await (await second.app.request(url, { headers })).json()).toEqual({ theme: "dark" });
    second.close();
  });

  it("reads and writes the file named by BRANCHBOARD_SETTINGS_FILE", async () => {
    const dataDirectory = mkdtempSync(join(directory, "settings-file-"));
    const settingsFile = join(dataDirectory, "other.json");
    const headers = { host: "127.0.0.1:47199", origin: "http://127.0.0.1:47199", "content-type": "application/json" };
    vi.stubEnv("BRANCHBOARD_SETTINGS_FILE", settingsFile);
    const server = createApp({ databasePath: join(dataDirectory, "t.db"), security: { port: 47199, extraOrigins: [] } });
    await server.app.request("http://127.0.0.1:47199/api/settings", { method: "PUT", headers, body: JSON.stringify({ theme: "light" }) });
    server.close();
    vi.unstubAllEnvs();
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({ theme: "light" });
    expect(existsSync(join(dataDirectory, "settings.json"))).toBe(false);
  });
});

describe("command summary", () => {
  it("summarises a command without its text", () => {
    const summary = summariseCommand({ type: "reply", boardId: "b1", nodeId: "n1", prompt: "my private prompt", model: "opus" });
    expect(JSON.stringify(summary)).not.toContain("private");
    expect(summary).toEqual({ type: "reply", boardId: "b1", nodeId: "n1", fields: ["prompt", "model"] });
  });
});

const node = (id: string, title: string) => ({ id, title }) as GraphNode;

describe("schema steps", () => {
  const pathOf = (name: string) => join(directory, name);
  const addStep = (to: number): SchemaStep => ({ to, rewrite: { nodes: (row) => ({ ...row, title: `${row.title}+${to}` }) } });

  it("backs up only an existing database, rewrites stored rows and keeps the last two backups", () => {
    openRepository(pathOf("fresh.db")).close();
    expect(readdirSync(directory).some((name) => name.startsWith("fresh.db.before"))).toBe(false);
    const path = pathOf("rows.db");
    const first = openRepository(path);
    first.upsertMany("nodes", () => "board", [node("n1", "a")]);
    first.close();
    [3, 4, 5].forEach((to) => {
      const repository = openRepository(path, [...SCHEMA_STEPS, ...Array.from({ length: to - 2 }, (_unused, index) => addStep(index + 3))]);
      repository.close();
    });
    const reopened = openRepository(path, [...SCHEMA_STEPS, addStep(3), addStep(4), addStep(5)]);
    expect(reopened.get<GraphNode>("nodes", "n1")?.title).toBe("a+3+4+5");
    reopened.close();
    const backups = readdirSync(directory).filter((name) => name.startsWith("rows.db.before-v"));
    expect(backups.sort()).toEqual(["rows.db.before-v4", "rows.db.before-v5"]);
  });

  it("applies the same rewrite to a document", () => {
    const document = { format: "branchboard", version: 2, board: {}, nodes: [node("n1", "a")], edges: [], parts: [], staleNodeIds: [] } as unknown as BoardDocument;
    const migrated = migrateDocumentWith(document, [...SCHEMA_STEPS, addStep(3)]);
    expect(migrated.version).toBe(3);
    expect(migrated.nodes[0].title).toBe("a+3");
  });
});

describe("clearing logs", () => {
  it("removes every clearable log source", () => {
    const dataDirectory = mkdtempSync(join(directory, "logs-"));
    mkdirSync(join(dataDirectory, "logs"));
    writeFileSync(join(dataDirectory, "logs", "server.log"), "x");
    writeFileSync(join(dataDirectory, "limits-history.jsonl"), "x");
    clearLogs(dataDirectory);
    expect(existsSync(join(dataDirectory, "logs"))).toBe(false);
    expect(existsSync(join(dataDirectory, "limits-history.jsonl"))).toBe(false);
  });
});
