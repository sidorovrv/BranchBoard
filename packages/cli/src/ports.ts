import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

export type PortState = { kind: "free" } | { kind: "busy" } | { kind: "branchboard"; dataDirId: string };

export type PortProbe = (port: number) => Promise<PortState>;

export type PortResolution = { kind: "reuse"; port: number } | { kind: "start"; port: number } | { kind: "none" };

const PROBE_TIMEOUT_MS = 4000;

export const probePort: PortProbe = async (port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/instance`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "error" });
    const body = (await response.json().catch(() => undefined)) as { app?: unknown; dataDirId?: unknown } | undefined;
    return body?.app === "branchboard" && typeof body.dataDirId === "string" ? { kind: "branchboard", dataDirId: body.dataDirId } : { kind: "busy" };
  } catch (error) {
    const code = ((error as { cause?: NodeJS.ErrnoException }).cause ?? (error as NodeJS.ErrnoException)).code;
    return code === "ECONNREFUSED" ? { kind: "free" } : { kind: "busy" };
  }
};

export const pickFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

export const readLastPort = (file: string): number | undefined => {
  try {
    const port = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
};

export const writeLastPort = (file: string, port: number): void => writeFileSync(file, String(port));

export interface PortRequest {
  requestedPort?: number;
  lastPort?: number;
  dataDirId: string;
  probe?: PortProbe;
  pickPort?: () => Promise<number>;
}

export const resolvePort = async ({ requestedPort, lastPort, dataDirId, probe = probePort, pickPort = pickFreePort }: PortRequest): Promise<PortResolution> => {
  const knownPort = requestedPort ?? lastPort;
  const state: PortState = knownPort === undefined ? { kind: "free" } : await probe(knownPort);
  if (knownPort !== undefined && state.kind === "branchboard" && state.dataDirId === dataDirId) return { kind: "reuse", port: knownPort };
  if (requestedPort !== undefined) return state.kind === "free" ? { kind: "start", port: requestedPort } : { kind: "none" };
  return { kind: "start", port: await pickPort() };
};
