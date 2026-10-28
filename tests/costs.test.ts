import { describe, expect, it } from "vitest";
import { COST_WINDOWS } from "@branchboard/core";
import { createCostStore, type CostEntry } from "../packages/server/src/costs";

const HOUR = COST_WINDOWS[0].ms;
const DAY = COST_WINDOWS[1].ms;

const entry = (at: number, costUsd: number, nodeId = "n1"): CostEntry => ({ at, boardId: "b1", nodeId, costUsd, inputTokens: 10, outputTokens: 5 });

const costOf = (store: ReturnType<typeof createCostStore>, id: string, at: number) => store.windows(at).find((summary) => summary.id === id)?.costUsd;

describe("cost windows", () => {
  it("sums each window over its own period", () => {
    const store = createCostStore();
    const current = 100 * DAY;
    store.record(entry(current - 10 * 60 * 1000, 1));
    store.record(entry(current - 5 * HOUR, 2, "n2"));
    store.record(entry(current - 3 * DAY, 4, "n3"));
    store.record(entry(current - 20 * DAY, 8, "n4"));
    store.record(entry(current - 40 * DAY, 16, "n5"));
    expect(["hour", "day", "week", "month"].map((id) => costOf(store, id, current))).toEqual([1, 3, 7, 15]);
  });

  it("counts a running node at its latest figure and replaces it when the run is recorded", () => {
    const store = createCostStore();
    const current = 100 * DAY;
    store.track(entry(current, 0.5));
    store.track(entry(current, 0.75));
    expect(costOf(store, "hour", current)).toBe(0.75);
    store.record(entry(current, 0.8));
    expect(costOf(store, "hour", current)).toBe(0.8);
    expect(store.windows(current)[0].runs).toBe(1);
  });

  it("keeps the start time of a running node and drops it when released", () => {
    const store = createCostStore();
    const current = 100 * DAY;
    store.track(entry(current - HOUR - 1000, 0.5));
    store.track(entry(current, 0.75));
    expect(costOf(store, "hour", current)).toBe(0);
    expect(costOf(store, "day", current)).toBe(0.75);
    store.release("n1");
    expect(costOf(store, "day", current)).toBe(0);
  });
});
