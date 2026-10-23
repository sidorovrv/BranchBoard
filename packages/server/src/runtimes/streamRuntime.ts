import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LimitsStore } from "../limits";
import { createChannel } from "../run/channel";
import { RecoverableError, type RunScope } from "../run/types";
import type { LooseNative } from "./commonEvents";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface LineSource<State> {
  lines: AsyncIterable<string>;
  kill(): void;
  endFailure(state: State): Promise<LooseNative | undefined>;
}

export interface StreamContext<Session, State> {
  session: Session;
  state: State;
  writeRunFile(name: string, content: string): string;
}

export interface StreamSpec<Handle, State extends { isFinished: boolean }, Session> {
  limits?: LimitsStore;
  temporaryDirectory: string;
  begin?(scope: RunScope, push: (native: LooseNative) => void): Session & { dispose(): void };
  open(handle: Handle, input: string, scope: RunScope, context: StreamContext<Session, State>): LineSource<State> | Promise<LineSource<State>>;
  createState(handle: Handle): State;
  translate(line: string, state: State): LooseNative[];
  finish?(state: State): LooseNative[];
}

export const writePrivateFile = (directory: string, fileName: string, content: string): string => {
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const path = join(directory, fileName);
  writeFileSync(path, content, { mode: PRIVATE_FILE_MODE });
  return path;
};

const pump = async <State extends { isFinished: boolean }>(source: LineSource<State>, state: State, spec: Pick<StreamSpec<unknown, State, unknown>, "translate" | "finish">, push: (native: LooseNative) => void, signal: AbortSignal) => {
  for await (const line of source.lines) spec.translate(line, state).forEach(push);
  if (signal.aborted) return;
  spec.finish?.(state).forEach(push);
  if (state.isFinished) return;
  const failure = await source.endFailure(state);
  if (failure) push(failure);
};

export const createStreamRuntime = <Handle, State extends { isFinished: boolean }, Session = object>(spec: StreamSpec<Handle, State, Session>) =>
  async function* execute(handle: Handle, input: string, scope: RunScope): AsyncGenerator<LooseNative> {
    const channel = createChannel<LooseNative>();
    const session = spec.begin?.(scope, channel.push);
    const runId = randomUUID();
    const runFiles: string[] = [];
    let source: LineSource<State> | undefined;
    const stop = () => source?.kill();
    scope.signal.addEventListener("abort", stop, { once: true });
    try {
      if (scope.signal.aborted) return;
      const writeRunFile = (name: string, content: string): string => {
        const path = writePrivateFile(spec.temporaryDirectory, `${runId}.${name}`, content);
        runFiles.push(path);
        return path;
      };
      const state = spec.createState(handle);
      source = await spec.open(handle, input, scope, { session: session as Session, state, writeRunFile });
      if (scope.signal.aborted) return stop();
      void pump(source, state, spec, channel.push, scope.signal)
        .catch((error) => channel.push({ type: "failure", message: error instanceof Error ? error.message : String(error) }))
        .finally(channel.close);
      for await (const native of channel.iterator) {
        if (native.type === "session") scope.setRuntimeRef({ sessionId: native.sessionId });
        else if (native.type === "limits") spec.limits?.record(native.info, { boardId: scope.boardId, nodeId: scope.nodeId });
        else if (native.type === "failure") throw native.recovery ? new RecoverableError(native.message, native.recovery) : new Error(native.message);
        else yield native;
        if (native.type === "done") return;
      }
    } finally {
      scope.signal.removeEventListener("abort", stop);
      stop();
      session?.dispose();
      runFiles.forEach((path) => rmSync(path, { force: true }));
    }
  };
