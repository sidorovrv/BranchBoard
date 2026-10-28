import { describe, expect, it } from "vitest";
import { createHub } from "../packages/server/src/hub";

describe("hub sequence numbers", () => {
  it("numbers each board's events from 1 and sends the number with the event", () => {
    const hub = createHub();
    const received: string[] = [];
    hub.subscribe("a", { send: (message) => received.push(message) });
    hub.broadcast("a", { type: "saved", at: 1 });
    hub.broadcast("b", { type: "saved", at: 2 });
    hub.broadcast("a", { type: "saved", at: 3 });
    expect(received.map((message) => JSON.parse(message).seq)).toEqual([1, 2]);
    expect(hub.seqOf("a")).toBe(2);
    expect(hub.seqOf("b")).toBe(1);
    expect(hub.seqOf("c")).toBe(0);
  });
});
