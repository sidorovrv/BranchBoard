import { describe, expect, it } from "vitest";
import { applyRunEvent, type Part } from "@branchboard/core";
import { failureOf, STREAM_ENDED_EARLY } from "../packages/server/src/runtimes/failures";
import { createChannel } from "../packages/server/src/run/channel";
import { createLimiter, withSlot } from "../packages/server/src/run/limiter";
import { askOnce } from "../packages/server/src/run/askOnce";
import { usageEvents, usageNative } from "../packages/server/src/runtimes/commonEvents";
import { sessionReferencesOf } from "@branchboard/core";
import type { RunScope, RuntimeSteps } from "../packages/server/src/run/types";
import { fakeRuntime } from "../packages/server/src/runtimes/fake";

describe("failure mapping", () => {
  it("picks a recovery from the error type or status", () => {
    expect(failureOf({ type: "provider.auth", message: "bad key" }).recovery).toBe("signIn");
    expect(failureOf({ status: 403 }).recovery).toBe("signIn");
    expect(failureOf({ status: 429 }).recovery).toBe("usageLimit");
    expect(failureOf({ type: "provider.no-route" }).recovery).toBe("setup");
    expect(failureOf({ isMissingEngine: true }).recovery).toBe("setup");
    expect(failureOf({ type: "provider.internal" }).recovery).toBeUndefined();
  });

  it("reads the engine's own error messages for an unreachable provider and an unknown model", () => {
    const keyError = failureOf({ status: 503, tag: "ServiceUnavailableError", message: "Incorrect API key provided: rejected-credential" }, ["rejected-credential"]);
    expect(keyError.recovery).toBe("signIn");
    expect(keyError.message).not.toContain("rejected-credential");
    expect(failureOf({ status: 503, tag: "ServiceUnavailableError", message: "connect ECONNREFUSED 127.0.0.1:1" })).toEqual({ message: "connect ECONNREFUSED 127.0.0.1:1", recovery: undefined });
    expect(failureOf({ status: 400, tag: "InvalidRequestError", message: "Model unavailable: mock/nope" })).toEqual({ message: "Model unavailable: mock/nope", recovery: undefined });
  });

  it("names timeouts and early stream ends", () => {
    expect(failureOf({ isEarlyEnd: true }).message).toBe(STREAM_ENDED_EARLY);
    expect(failureOf({ isTimeout: true }).message).toMatch(/did not answer in time/);
  });
});

describe("retry parts", () => {
  const applyAll = (events: Parameters<typeof applyRunEvent>[3][]): Part[] => events.reduce((parts, event) => applyRunEvent(parts, "n", 1, event), [] as Part[]);

  it("shows the latest retry until text arrives", () => {
    const parts = applyAll([
      { type: "retry", attempt: 2, at: 10, reason: "first" },
      { type: "retry", attempt: 3, at: 20, reason: "second" },
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "retry", text: "second", meta: { attempt: 3, at: 20 } });
    expect(applyAll([{ type: "retry", attempt: 2, at: 10, reason: "x" }, { type: "part.delta", partKey: "t", partType: "text", text: "Hi" }]).map((part) => part.type)).toEqual(["text"]);
  });

  it("removes the notice when the run ends or fails", () => {
    expect(applyAll([{ type: "retry", attempt: 2, at: 1, reason: "x" }, { type: "done" }])).toEqual([]);
    expect(applyAll([{ type: "retry", attempt: 2, at: 1, reason: "x" }, { type: "error", message: "boom" }]).map((part) => part.type)).toEqual(["error"]);
  });

  it("drops the parts named by a restart", () => {
    const parts = applyAll([
      { type: "part.delta", partKey: "a", partType: "text", text: "Partial" },
      { type: "retry-restart", partKeys: ["a"] },
      { type: "part.delta", partKey: "b", partType: "text", text: "Partial" },
    ]);
    expect(parts.map((part) => part.text)).toEqual(["Partial"]);
  });
});

describe("shared run steps", () => {
  it("builds usage natives that keep cost", () => {
    const native = usageNative({ inputTokens: 5, outputTokens: 2, contextTokens: 5, costUsd: 0.5 });
    expect(usageEvents(native)).toEqual([{ type: "usage", usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2, contextTokens: 5, costUsd: 0.5 }) }]);
  });

  it("delivers queued and later channel items in order and ends when closed", async () => {
    const channel = createChannel<number>();
    channel.push(1);
    const collected: number[] = [];
    const reading = (async () => {
      for await (const item of channel.iterator) collected.push(item);
    })();
    channel.push(2);
    channel.push(3);
    channel.close();
    channel.push(4);
    await reading;
    expect(collected).toEqual([1, 2, 3]);
  });

  it("runs at most the limit and lets waiters in as slots free", async () => {
    const limiter = createLimiter(2);
    const signal = new AbortController().signal;
    const first = await limiter.acquire(signal);
    const second = await limiter.acquire(signal);
    let thirdGranted = false;
    const third = limiter.acquire(signal).then((release) => ((thirdGranted = true), release));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdGranted).toBe(false);
    first!();
    first!();
    const thirdRelease = await third;
    expect(thirdGranted).toBe(true);
    expect(limiter.activeCount()).toBe(2);
    second!();
    thirdRelease!();
    expect(limiter.activeCount()).toBe(0);
  });

  it("waits for a slot, reports waiting, and gives up when aborted", async () => {
    const limiter = createLimiter(1);
    const holder = await limiter.acquire(new AbortController().signal);
    const states: boolean[] = [];
    const controller = new AbortController();
    const waiting = withSlot(limiter, controller.signal, (isWaiting) => states.push(isWaiting), async () => "ran");
    controller.abort();
    expect(await waiting).toBeUndefined();
    expect(states).toEqual([true, false]);
    holder!();
    expect(await withSlot(limiter, new AbortController().signal, undefined, async () => "ran")).toBe("ran");
    expect(limiter.activeCount()).toBe(0);
  });

  it("generates text through the runtime inside its slot", async () => {
    const slots = createLimiter(1);
    let active = 0;
    const runtime: RuntimeSteps = {
      ...fakeRuntime,
      slots,
      generateText: async (input, purpose) => {
        active = slots.activeCount();
        return `${purpose}:${input}`;
      },
    };
    const scope: Pick<RunScope, "boardId" | "nodeId" | "workspacePath"> = { boardId: "b", nodeId: "n", workspacePath: process.cwd() };
    expect(await askOnce({ runtime, scope, input: "hi", purpose: "summary", timeoutMs: 1000 })).toBe("summary:hi");
    expect(active).toBe(1);
    expect(slots.activeCount()).toBe(0);
  });

  it("collects each session of a node and its rolls once", () => {
    const references = sessionReferencesOf([
      { id: "n", runtimeRef: { sessionId: "a" }, rolls: { 1: { runtimeRef: { sessionId: "b" } }, 2: { runtimeRef: { sessionId: "a" } } } } as never,
      { id: "m" } as never,
    ]);
    expect(references.map((reference) => reference.sessionId).sort()).toEqual(["a", "b"]);
  });
});
