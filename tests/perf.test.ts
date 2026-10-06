import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPerfLog, PERF_SAMPLE_MS } from "../packages/server/src/perfLog";

const directory = mkdtempSync(join(tmpdir(), "branchboard-perf-"));

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const recordsOf = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe("performance log", () => {
  it("stores a web sample with its source and a timestamp", () => {
    const perfLog = createPerfLog(join(directory, "web"));
    expect(perfLog.recordWebSample({ longTaskCount: 2, nodes: 40 })).toBe(true);
    const [record] = recordsOf(perfLog.file);
    expect(record).toMatchObject({ source: "web", longTaskCount: 2, nodes: 40 });
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
  });

  it("refuses samples that are not objects or are too large", () => {
    const perfLog = createPerfLog(join(directory, "refused"));
    expect(perfLog.recordWebSample("text")).toBe(false);
    expect(perfLog.recordWebSample([1, 2])).toBe(false);
    expect(perfLog.recordWebSample(null)).toBe(false);
    expect(perfLog.recordWebSample({ blob: "x".repeat(20000) })).toBe(false);
  });

  it("writes server samples with cpu, event loop delay and grouped request counts", async () => {
    const perfLog = createPerfLog(join(directory, "server"));
    perfLog.countRequest("GET", "/api/runs");
    perfLog.countRequest("GET", "/api/runs");
    perfLog.countRequest("GET", "/api/attachments/3f2b8c1e-aaaa-bbbb-cccc-123456789abc");
    const stop = perfLog.startServerSampling(() => ({ activeRuns: 1, socketClients: 2, socketMessages: 3 }));
    await new Promise((resolve) => setTimeout(resolve, PERF_SAMPLE_MS + 500));
    stop();
    const [record] = recordsOf(perfLog.file);
    expect(record).toMatchObject({ source: "server", activeRuns: 1, socketClients: 2, socketMessages: 3 });
    expect(record.requests).toEqual({ "GET /api/runs": 2, "GET /api/attachments/:id": 1 });
    expect(record.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(record.loopDelayMaxMs).toBeGreaterThanOrEqual(0);
  }, 15000);
});
