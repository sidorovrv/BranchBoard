import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { log } from "../log";
import type { Location } from "./opencodeLocator";
import { killTree, withoutCurrentDirectorySearch } from "./spawnProcess";

export interface OpencodeServer {
  baseUrl: string;
  authorization: string;
  child?: ChildProcess;
}

export interface ServerFlavor {
  logName: string;
  label: string;
  healthPath: string;
  locate(): Location;
  missingMessage: string;
}

const STARTUP_TIMEOUT_MS = 20000;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const OUTPUT_TAIL_CHARS = 2000;
const PROGRESS_LOG_MS = 3000;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

export const splitModel = (model: string | undefined) => {
  if (!model || !model.includes("/")) return undefined;
  const [providerID, ...rest] = model.split("/");
  return { providerID, modelID: rest.join("/") };
};

export const isNotFound = (error: unknown): boolean => error instanceof Error && error.message.includes("failed with 404");

export async function* serverSentEvents<Event>(response: Response, signal: AbortSignal): AsyncGenerator<Event> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (signal.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
      if (data) yield JSON.parse(data) as Event;
    }
  }
}

export const createServerPool = (flavor: ServerFlavor) => {
  const servers = new Map<string, Promise<OpencodeServer>>();

  const call = async (server: OpencodeServer, directory: string, path: string, init: RequestInit = {}) => {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(`${server.baseUrl}${path}${separator}directory=${encodeURIComponent(directory)}`, {
      ...init,
      headers: { authorization: server.authorization, "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      log.error(flavor.logName, `${init.method ?? "GET"} ${path} failed with ${response.status}`, body);
      throw new Error(`${flavor.label} ${path} failed with ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    return response;
  };

  const callJson = async (server: OpencodeServer, directory: string, path: string, init?: RequestInit) =>
    (await call(server, directory, path, init)).json() as Promise<any>;

  const post = (server: OpencodeServer, directory: string, path: string, body?: unknown) =>
    call(server, directory, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

  const requestHealth = (server: OpencodeServer) => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`no answer within ${HEALTH_REQUEST_TIMEOUT_MS}ms`));
      }, HEALTH_REQUEST_TIMEOUT_MS);
    });
    const request = fetch(`${server.baseUrl}${flavor.healthPath}`, { headers: { authorization: server.authorization }, signal: controller.signal });
    request.catch(() => undefined);
    return Promise.race([request, timedOut]).finally(() => clearTimeout(timer));
  };

  const waitUntilHealthy = async (server: OpencodeServer) => {
    const started = Date.now();
    const deadline = started + STARTUP_TIMEOUT_MS;
    let lastReason = "no response yet";
    let nextProgressLog = started + PROGRESS_LOG_MS;
    while (Date.now() < deadline && server.child?.exitCode == null) {
      const healthy = await requestHealth(server).then(
        (response) => {
          if (!response.ok) lastReason = `health returned ${response.status}`;
          return response.ok;
        },
        (error) => {
          lastReason = `connection failed: ${error?.cause?.code ?? error?.message ?? error}`;
          return false;
        },
      );
      if (healthy) {
        log.info(flavor.logName, `Server healthy after ${Date.now() - started}ms at ${server.baseUrl}`);
        return;
      }
      if (Date.now() >= nextProgressLog) {
        log.warn(flavor.logName, `Still waiting for ${server.baseUrl} (${Date.now() - started}ms, ${lastReason})`);
        nextProgressLog += PROGRESS_LOG_MS;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (server.child?.exitCode != null) throw new Error(`${flavor.label} serve exited before becoming healthy`);
    log.error(flavor.logName, `Gave up waiting for ${server.baseUrl} after ${STARTUP_TIMEOUT_MS}ms (${lastReason})`);
    throw new Error(`${flavor.label} serve did not become healthy in time`);
  };

  const startServer = async (directory: string): Promise<OpencodeServer> => {
    const located = flavor.locate();
    if (!located.path) {
      log.error(flavor.logName, `Could not find the ${flavor.label} executable`, located.searched.join("\n"));
      throw new Error(flavor.missingMessage);
    }
    const password = randomBytes(16).toString("hex");
    const port = await freePort();
    log.info(flavor.logName, `Spawning ${located.path} serve on port ${port} in ${directory}`);
    const isWindows = process.platform === "win32";
    const child = spawn(isWindows ? `"${located.path}"` : located.path, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: directory,
      env: withoutCurrentDirectorySearch({ ...process.env, OPENCODE_SERVER_PASSWORD: password }),
      shell: isWindows,
      stdio: ["ignore", "pipe", "pipe"],
    });
    log.debug(flavor.logName, `Spawned pid ${child.pid}`);
    let output = "";
    const remember = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
      chunk.toString().split(/\r?\n/).filter(Boolean).forEach((line) => log.debug(flavor.logName, `pid ${child.pid}: ${line}`));
    };
    child.stdout?.on("data", remember);
    child.stderr?.on("data", remember);
    const failure = new Promise<never>((_resolve, reject) => {
      child.on("error", (error) => {
        log.error(flavor.logName, `Could not spawn ${located.path}`, error);
        reject(new Error(`Could not start ${flavor.label}: ${error.message}. Is it installed and on PATH?`));
      });
      child.on("exit", (code, signal) => {
        log.error(flavor.logName, `${flavor.label} serve (pid ${child.pid}) exited with code ${code} signal ${signal}`, output.trim() || undefined);
        servers.delete(directory);
        reject(new Error(`${flavor.label} serve exited with code ${code} in ${directory}. ${output.trim()}`));
      });
    });
    failure.catch(() => undefined);
    const server: OpencodeServer = { baseUrl: `http://127.0.0.1:${port}`, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, child };
    process.on("exit", () => killTree(child));
    try {
      await Promise.race([waitUntilHealthy(server), failure]);
    } catch (error) {
      killTree(child);
      if (error instanceof Error && error.message.includes("did not become healthy")) throw new Error(`${error.message} ${output.trim()}`);
      throw error;
    }
    return server;
  };

  const serverFor = (directory: string): Promise<OpencodeServer> => {
    const existing = servers.get(directory);
    if (existing) return existing;
    const started = startServer(directory);
    servers.set(directory, started);
    started.catch(() => servers.delete(directory));
    return started;
  };

  return { servers, call, callJson, post, serverFor };
};
