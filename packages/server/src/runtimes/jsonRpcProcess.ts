import { createChannel } from "../run/channel";
import { log } from "../log";
import type { ProcessExit, RunningProcess } from "./spawnProcess";

export type RpcId = string | number;

export interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string };
}

export type ServerRequestHandler = (method: string, params: any) => Promise<unknown>;

export interface LineSubscription {
  lines: AsyncIterable<string>;
  close(): void;
}

export interface JsonRpcProcess {
  request<Result = any>(method: string, params?: unknown, timeoutMs?: number): Promise<Result>;
  notify(method: string, params?: unknown): void;
  onServerRequest(handler: ServerRequestHandler): void;
  onNotification(listener: (message: RpcMessage) => void): () => void;
  lines(filter: (message: RpcMessage) => boolean): LineSubscription;
  exit: Promise<ProcessExit>;
  kill(): void;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const INTERNAL_ERROR = -32603;

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const parseMessage = (line: string): RpcMessage | undefined => {
  try {
    const parsed: unknown = line.trim() ? JSON.parse(line) : undefined;
    return typeof parsed === "object" && parsed !== null ? (parsed as RpcMessage) : undefined;
  } catch {
    return undefined;
  }
};

export const startJsonRpcProcess = (running: RunningProcess, label: string): JsonRpcProcess => {
  const pending = new Map<RpcId, Pending>();
  const listeners = new Set<(message: RpcMessage, line: string) => void>();
  let handler: ServerRequestHandler = async (method) => {
    throw new Error(`${method} is not supported by Branchboard`);
  };
  let nextId = 1;
  let closedReason: string | undefined;

  const write = (message: RpcMessage) => running.writeInput(`${JSON.stringify(message)}\n`);

  const settle = (message: RpcMessage) => {
    const entry = pending.get(message.id!);
    if (!entry) return;
    pending.delete(message.id!);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new RpcError(message.error.message ?? "The request failed", message.error.code));
    else entry.resolve(message.result);
  };

  const answerServerRequest = async (message: RpcMessage) => {
    try {
      write({ id: message.id, result: await handler(message.method!, message.params) });
    } catch (error) {
      write({ id: message.id, error: { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) } });
    }
  };

  const route = (line: string) => {
    const message = parseMessage(line);
    if (!message) return log.debug(label, `Ignored non-JSON output line: ${line.slice(0, 200)}`);
    if (message.id !== undefined && message.method === undefined) return settle(message);
    if (message.id !== undefined) return void answerServerRequest(message);
    listeners.forEach((listener) => listener(message, line));
  };

  const exit = (async () => {
    for await (const line of running.lines) route(line);
    const ended = await running.exit;
    closedReason = `The ${label} process exited with code ${ended.code}${ended.stderrTail ? `: ${ended.stderrTail}` : ""}`;
    pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(new Error(closedReason));
    });
    pending.clear();
    listeners.forEach((listener) => listener({ method: "process/exited" }, ""));
    listeners.clear();
    return ended;
  })();

  const request = <Result>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      if (closedReason) return reject(new Error(closedReason));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The ${label} process did not answer ${method} in time`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
      write({ id, method, params });
    });

  const onNotification = (listener: (message: RpcMessage) => void) => {
    const wrapped = (message: RpcMessage) => listener(message);
    if (closedReason) {
      queueMicrotask(() => wrapped({ method: "process/exited" }));
      return () => undefined;
    }
    listeners.add(wrapped);
    return () => void listeners.delete(wrapped);
  };

  const lines = (filter: (message: RpcMessage) => boolean): LineSubscription => {
    const channel = createChannel<string>();
    const listener = (message: RpcMessage, line: string) => {
      if (message.method === "process/exited") channel.close();
      else if (filter(message)) channel.push(line);
    };
    listeners.add(listener);
    if (closedReason) channel.close();
    return {
      lines: channel.iterator,
      close: () => {
        listeners.delete(listener);
        channel.close();
      },
    };
  };

  return {
    request,
    notify: (method, params) => write({ method, ...(params === undefined ? {} : { params }) }),
    onServerRequest: (next) => void (handler = next),
    onNotification,
    lines,
    exit,
    kill: () => running.kill(),
  };
};
