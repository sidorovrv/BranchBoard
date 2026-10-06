import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { log } from "./log";

export const PERF_SAMPLE_MS = 5000;
const MAX_PERF_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WEB_SAMPLE_BYTES = 16 * 1024;
const TOP_REQUEST_KEYS = 8;
const NANOSECONDS_PER_MILLISECOND = 1e6;
const MICROSECONDS_PER_MILLISECOND = 1000;
const BYTES_PER_MEGABYTE = 1024 * 1024;

export interface ServerPerfContext {
  activeRuns: number;
  socketClients: number;
  socketMessages: number;
}

const roundTo = (value: number, digits = 1): number => Math.round(value * 10 ** digits) / 10 ** digits;

const topCounts = (counts: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, TOP_REQUEST_KEYS));

export const createPerfLog = (directory: string) => {
  const file = join(directory, "perf.jsonl");
  const requestCounts = new Map<string, number>();

  const rotateIfLarge = () => {
    if (!existsSync(file) || statSync(file).size < MAX_PERF_FILE_BYTES) return;
    rmSync(`${file}.1`, { force: true });
    renameSync(file, `${file}.1`);
  };

  const append = (source: "server" | "web", record: Record<string, unknown>) => {
    try {
      mkdirSync(directory, { recursive: true });
      rotateIfLarge();
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), source, ...record })}\n`);
    } catch (error) {
      log.warn("perf", "Could not write the performance log", error);
    }
  };

  const countRequest = (method: string, path: string) => {
    const key = `${method} ${path.replace(/\/[0-9a-f-]{8,}/gi, "/:id")}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
  };

  const recordWebSample = (sample: unknown): boolean => {
    if (typeof sample !== "object" || sample === null || Array.isArray(sample)) return false;
    if (JSON.stringify(sample).length > MAX_WEB_SAMPLE_BYTES) return false;
    append("web", sample as Record<string, unknown>);
    return true;
  };

  const startServerSampling = (describe: () => ServerPerfContext): (() => void) => {
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    let previousCpu = process.cpuUsage();
    let previousAt = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const cpu = process.cpuUsage(previousCpu);
      const elapsedMicroseconds = (now - previousAt) * MICROSECONDS_PER_MILLISECOND;
      previousCpu = process.cpuUsage();
      previousAt = now;
      const memory = process.memoryUsage();
      append("server", {
        cpuPercent: roundTo(((cpu.user + cpu.system) / elapsedMicroseconds) * 100),
        loopDelayP50Ms: roundTo(loopDelay.percentile(50) / NANOSECONDS_PER_MILLISECOND),
        loopDelayP99Ms: roundTo(loopDelay.percentile(99) / NANOSECONDS_PER_MILLISECOND),
        loopDelayMaxMs: roundTo(loopDelay.max / NANOSECONDS_PER_MILLISECOND),
        rssMb: roundTo(memory.rss / BYTES_PER_MEGABYTE),
        heapUsedMb: roundTo(memory.heapUsed / BYTES_PER_MEGABYTE),
        requests: topCounts(requestCounts),
        ...describe(),
      });
      loopDelay.reset();
      requestCounts.clear();
    }, PERF_SAMPLE_MS);
    timer.unref();
    return () => {
      clearInterval(timer);
      loopDelay.disable();
    };
  };

  return { file, countRequest, recordWebSample, startServerSampling };
};

export type PerfLog = ReturnType<typeof createPerfLog>;
