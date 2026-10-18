import { describe, expect, it } from "vitest";
import { createChannel } from "../packages/server/src/run/channel";
import { startJsonRpcProcess } from "../packages/server/src/runtimes/jsonRpcProcess";
import type { ProcessExit, RunningProcess } from "../packages/server/src/runtimes/spawnProcess";

class LineProcess implements RunningProcess {
  written: any[] = [];
  wasKilled = false;
  private readonly channel = createChannel<string>();
  private finishExit!: (exit: ProcessExit) => void;
  readonly lines = this.channel.iterator;
  readonly exit = new Promise<ProcessExit>((resolve) => (this.finishExit = resolve));

  writeInput(text: string) {
    text.split("\n").filter(Boolean).forEach((line) => this.written.push(JSON.parse(line)));
  }
  endInput() {}
  send(message: unknown) {
    this.channel.push(JSON.stringify(message));
  }
  sendLine(line: string) {
    this.channel.push(line);
  }
  finish(code: number | null, stderrTail = "") {
    this.channel.close();
    this.finishExit({ code, stderrTail });
  }
  kill() {
    this.wasKilled = true;
    this.finish(null);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("JSON-RPC line process", () => {
  it("writes one message per line without a jsonrpc field and matches interleaved responses", async () => {
    const process = new LineProcess();
    const rpc = startJsonRpcProcess(process, "codex");
    const first = rpc.request("thread/start", { cwd: "/w" });
    const second = rpc.request("model/list");
    expect(process.written).toEqual([{ id: 1, method: "thread/start", params: { cwd: "/w" } }, { id: 2, method: "model/list" }]);
    process.send({ id: 2, result: { data: [] } });
    process.send({ id: 1, result: { thread: { id: "t1" } } });
    await expect(first).resolves.toEqual({ thread: { id: "t1" } });
    await expect(second).resolves.toEqual({ data: [] });
  });

  it("rejects a request whose response carries an error", async () => {
    const process = new LineProcess();
    const rpc = startJsonRpcProcess(process, "codex");
    const forked = rpc.request("thread/fork", { threadId: "gone" });
    process.send({ id: 1, error: { code: -32600, message: "no rollout found for thread id gone" } });
    await expect(forked).rejects.toThrow("no rollout found for thread id gone");
  });

  it("answers server requests with the handler's result or its error", async () => {
    const process = new LineProcess();
    const rpc = startJsonRpcProcess(process, "codex");
    rpc.onServerRequest(async (method, params) => {
      if (method === "item/tool/call") throw new Error("item/tool/call is not supported by Branchboard");
      return { decision: params.ok ? "accept" : "decline" };
    });
    process.send({ id: 0, method: "item/commandExecution/requestApproval", params: { ok: true } });
    process.send({ id: "x", method: "item/tool/call", params: {} });
    await settle();
    expect(process.written).toEqual([
      { id: 0, result: { decision: "accept" } },
      { id: "x", error: { code: -32603, message: "item/tool/call is not supported by Branchboard" } },
    ]);
  });

  it("refuses server requests until a handler is set", async () => {
    const process = new LineProcess();
    startJsonRpcProcess(process, "codex");
    process.send({ id: 3, method: "attestation/generate", params: {} });
    await settle();
    expect(process.written[0]).toMatchObject({ id: 3, error: { message: "attestation/generate is not supported by Branchboard" } });
  });

  it("streams the notification lines a filter accepts and skips lines that are not JSON", async () => {
    const process = new LineProcess();
    const rpc = startJsonRpcProcess(process, "codex");
    const seen: string[] = [];
    rpc.onNotification((message) => seen.push(String(message.method)));
    const subscription = rpc.lines((message) => message.params?.threadId === "t1");
    process.send({ method: "turn/started", params: { threadId: "t1" } });
    process.sendLine("warning: not json");
    process.send({ method: "turn/started", params: { threadId: "t2" } });
    process.send({ method: "turn/completed", params: { threadId: "t1" } });
    await settle();
    subscription.close();
    const received: string[] = [];
    for await (const line of subscription.lines) received.push(JSON.parse(line).method);
    expect(received).toEqual(["turn/started", "turn/completed"]);
    expect(seen).toEqual(["turn/started", "turn/started", "turn/completed"]);
  });

  it("fails pending requests and ends line streams when the process exits", async () => {
    const process = new LineProcess();
    const rpc = startJsonRpcProcess(process, "codex");
    const pending = rpc.request("turn/start", {});
    const subscription = rpc.lines(() => true);
    process.finish(1, "boom");
    await expect(pending).rejects.toThrow("The codex process exited with code 1: boom");
    const received: string[] = [];
    for await (const line of subscription.lines) received.push(line);
    expect(received).toEqual([]);
    await expect(rpc.request("model/list")).rejects.toThrow("exited with code 1");
    expect((await rpc.exit).code).toBe(1);
  });

  it("tells a notification listener added after the exit that the process exited", async () => {
    const process = new LineProcess();
    const rpc = startJsonRpcProcess(process, "codex");
    process.finish(1);
    await rpc.exit;
    const methods: (string | undefined)[] = [];
    rpc.onNotification((message) => methods.push(message.method));
    await Promise.resolve();
    expect(methods).toEqual(["process/exited"]);
  });

  it("gives up on a request that gets no answer in time", async () => {
    const process = new LineProcess();
    const rpc = startJsonRpcProcess(process, "codex");
    await expect(rpc.request("model/list", undefined, 10)).rejects.toThrow("did not answer model/list in time");
  });
});
