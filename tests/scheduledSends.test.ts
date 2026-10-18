import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelScheduledSend, formatRunCountdown, nextOccurrence, scheduleSend, useScheduledSends } from "../packages/web/src/scheduledSends";

const localTime = (hour: number, minute: number) => new Date(2026, 9, 16, hour, minute, 0, 0).getTime();

describe("nextOccurrence", () => {
  it("returns today's time when it is still ahead", () => {
    expect(nextOccurrence(14, 30, localTime(9, 0))).toBe(localTime(14, 30));
  });

  it("moves to tomorrow when the time has passed or is now", () => {
    expect(nextOccurrence(9, 0, localTime(9, 0))).toBe(new Date(2026, 9, 17, 9, 0).getTime());
    expect(nextOccurrence(8, 59, localTime(9, 0))).toBe(new Date(2026, 9, 17, 8, 59).getTime());
  });
});

describe("formatRunCountdown", () => {
  it("shows minutes and seconds under an hour", () => {
    expect(formatRunCountdown(59_000)).toBe("00:59");
    expect(formatRunCountdown(4 * 60_000 + 5_000)).toBe("04:05");
    expect(formatRunCountdown(59 * 60_000 + 59_000)).toBe("59:59");
  });

  it("shows hours and minutes from one hour on", () => {
    expect(formatRunCountdown(3600_000)).toBe("1h00m");
    expect(formatRunCountdown(2 * 3600_000 + 5 * 60_000)).toBe("2h05m");
  });

  it("never goes below zero", () => {
    expect(formatRunCountdown(-5_000)).toBe("00:00");
  });
});

describe("scheduleSend", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cancelScheduledSend("node-a");
    vi.useRealTimers();
  });

  it("runs the send once at the scheduled time and clears the schedule", () => {
    const send = vi.fn();
    const at = Date.now() + 60_000;
    scheduleSend("node-a", at, send);
    expect(useScheduledSends.getState().runAt["node-a"]).toBe(at);

    vi.advanceTimersByTime(59_999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(useScheduledSends.getState().runAt["node-a"]).toBeUndefined();
  });

  it("keeps the details of a schedule until it runs or is cancelled", () => {
    const details = { boardId: "board-a", title: "Nightly", prompt: "Summarise" };
    scheduleSend("node-a", Date.now() + 60_000, vi.fn(), details);
    expect(useScheduledSends.getState().details["node-a"]).toEqual(details);
    cancelScheduledSend("node-a");
    expect(useScheduledSends.getState().details["node-a"]).toBeUndefined();
  });

  it("replaces an earlier schedule of the same node", () => {
    const first = vi.fn();
    const second = vi.fn();
    scheduleSend("node-a", Date.now() + 60_000, first);
    scheduleSend("node-a", Date.now() + 120_000, second);
    vi.advanceTimersByTime(120_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not run after it is cancelled", () => {
    const send = vi.fn();
    scheduleSend("node-a", Date.now() + 60_000, send);
    cancelScheduledSend("node-a");
    vi.advanceTimersByTime(120_000);
    expect(send).not.toHaveBeenCalled();
    expect(useScheduledSends.getState().runAt["node-a"]).toBeUndefined();
  });
});
