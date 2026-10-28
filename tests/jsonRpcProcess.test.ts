import { describe, expect, it } from "vitest";
import { startJsonRpcProcess } from "../packages/server/src/runtimes/jsonRpcProcess";
import { ScriptedProcess } from "./support";

class LineProcess extends ScriptedProcess {
  written: any[] = [];

  writeInput(text: string) {
    text.split("\n").filter(Boolean).forEach((line) => this.written.push(JSON.parse(line)));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("JSON-RPC line process", () => {
  it("writes one message per line without a jsonrpc field, matches interleaved responses and rejects error responses", async () => {
    const process = new LineProcess();
    const rpc = startJsonRpcProcess(process, "codex");
    const first = rpc.request("thread/start", { cwd: "/w" });
    const second = rpc.request("model/list");
    const forked = rpc.request("thread/fork", { threadId: "gone" });
    expect(process.written).toEqual([{ id: 1, method: "thread/start", params: { cwd: "/w" } }, { id: 2, method: "model/list" }, { id: 3, method: "thread/fork", params: { threadId: "gone" } }]);
    process.emit({ id: 2, result: { data: [] } });
    process.emit({ id: 1, result: { thread: { id: "t1" } } });
    process.emit({ id: 3, error: { code: -32600, message: "no rollout found for thread id gone" } });
    await expect(first).resolves.toEqual({ thread: { id: "t1" } });
    await expect(second).resolves.toEqual({ data: [] });
    await expect(forked).rejects.toThrow("no rollout found for thread id gone");
  });

  it("refuses server requests until a handler is set, then answers with the handler's result or its error", async () => {
    const process = new LineProcess();
    const rpc = startJsonRpcProcess(process, "codex");
    process.emit({ id: 3, method: "attestation/generate", params: {} });
    await settle();
    rpc.onServerRequest(async (method, params) => {
      if (method === "item/tool/call") throw new Error("item/tool/call is not supported by Branchboard");
      return { decision: params.ok ? "accept" : "decline" };
    });
    process.emit({ id: 0, method: "item/commandExecution/requestApproval", params: { ok: true } });
    process.emit({ id: "x", method: "item/tool/call", params: {} });
    await settle();
    expect(process.written).toEqual([
      { id: 3, error: { code: -32603, message: "attestation/generate is not supported by Branchboard" } },
      { id: 0, result: { decision: "accept" } },
      { id: "x", error: { code: -32603, message: "item/tool/call is not supported by Branchboard" } },
    ]);
  });

  it("streams the notification lines a filter accepts and skips lines that are not JSON", async () => {
    const process = new LineProcess();
    const rpc = startJsonRpcProcess(process, "codex");
    const seen: string[] = [];
    rpc.onNotification((message) => seen.push(String(message.method)));
    const subscription = rpc.lines((message) => message.params?.threadId === "t1");
    process.emit({ method: "turn/started", params: { threadId: "t1" } });
    process.emitLine("warning: not json");
    process.emit({ method: "turn/started", params: { threadId: "t2" } });
    process.emit({ method: "turn/completed", params: { threadId: "t1" } });
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
