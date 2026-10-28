import { describe, expect, it } from "vitest";
import {
  addDays,
  applyUsageEvent,
  branchingOf,
  buildDailyPayload,
  daysBetween,
  daysToSend,
  emptyDay,
  isDailyPayload,
  localDayOf,
  mergeBranching,
  normalizeDay,
  shouldAskForConsent,
  telemetryTiles,
  type TelemetryFacts,
  type UsageEvent,
  type UsageLedger,
} from "@branchboard/core";
import { buildGraph } from "./support";

const facts: TelemetryFacts = {
  payloadId: "0b4c2f3e-52a1-4c7e-9d64-1f0a8d3c5b21",
  version: "0.3.0",
  os: "linux",
  nodeMajor: 24,
  boardsTotal: 3,
  branching: { maxDepth: 2, maxChildren: 3, avgChildren: 1.5 },
};

const run = (overrides: Partial<Extract<UsageEvent, { type: "run" }>> = {}): UsageEvent => ({
  type: "run",
  boardId: "b1",
  outcome: "done",
  stopped: false,
  runtime: "claude",
  contextMode: "exact",
  isRegeneration: false,
  ...overrides,
});

const dayWith = (events: UsageEvent[]) => events.reduce(applyUsageEvent, emptyDay());

describe("usage events", () => {
  it("counts runs by outcome, runtime, context mode and recovery", () => {
    const day = dayWith([run(), run({ stopped: true, isRegeneration: true }), run({ outcome: "error", recovery: "usageLimit" }), run({ outcome: "error" }), run({ outcome: "interrupted", contextMode: undefined })]);
    expect(day.runs).toMatchObject({ started: 5, done: 2, error: 2, interrupted: 1, stopped: 1, regenerations: 1, byRuntime: { claude: 5 }, byContextMode: { exact: 4 }, failuresByRecovery: { usageLimit: 1, other: 1 } });
  });

  it("marks a board active once for any event and counts created nodes and undo steps", () => {
    const day = dayWith([{ type: "edit", boardId: "b1" }, { type: "edit", boardId: "b1" }, { type: "nodeCreated", boardId: "b2", kind: "note" }, { type: "undo", boardId: "b2" }, { type: "boardCreated", boardId: "b3" }]);
    expect(day).toMatchObject({ activeBoardIds: ["b1", "b2", "b3"], nodesCreated: { note: 1 }, undo: 1, boardsCreated: 1 });
  });

  it("returns the same day object when an edit adds nothing", () => {
    const day = dayWith([{ type: "edit", boardId: "b1" }]);
    expect(applyUsageEvent(day, { type: "edit", boardId: "b1" })).toBe(day);
  });
});

describe("daily payload", () => {
  const ledger: UsageLedger = {
    firstDay: "2026-10-01",
    days: {
      "2026-10-09": dayWith([{ type: "edit", boardId: "b1" }]),
      "2026-10-15": dayWith([{ type: "edit", boardId: "b1" }]),
      "2026-10-16": dayWith([run(), run(), run(), { type: "nodeCreated", boardId: "b1", kind: "reply" }, { type: "boardCreated", boardId: "b9" }]),
    },
  };

  it("leaves zero entries out, carries no model counts and computes retention from the ledger", () => {
    const payload = buildDailyPayload("2026-10-16", ledger, facts);
    expect(payload.runs).not.toHaveProperty("byModel");
    expect(payload.nodesCreated).toEqual({ reply: 1 });
    expect(payload.runs.failuresByRecovery).toEqual({});
    expect(payload.boards).toEqual({ total: 3, created: 1, active: 2 });
    expect(payload.retention).toEqual({ installAgeDays: 15, daysActiveLast7: 2, daysActiveLast28: 3 });
  });

  it("builds a valid payload for a day without activity", () => {
    expect(isDailyPayload(buildDailyPayload("2026-10-17", ledger, facts))).toBe(true);
  });

  it("lists tiles that carry the counts", () => {
    const tiles = telemetryTiles(buildDailyPayload("2026-10-16", ledger, facts));
    expect(tiles).toContainEqual({ group: "Activity", label: "Runs today", value: 3 });
    expect(tiles).toContainEqual({ group: "Boards", label: "Avg. branches of a node", value: 1.5 });
    expect(tiles.some((tile) => tile.group === "Models")).toBe(false);
    expect(tiles).toContainEqual({ group: "Runtimes", label: "Runs on claude", value: 3 });
  });
});

describe("payload schema", () => {
  const valid = () => JSON.parse(JSON.stringify(buildDailyPayload("2026-10-16", { firstDay: "2026-10-01", days: {} }, facts)));

  it("rejects an unknown field, a wrong type and a malformed identifier", () => {
    expect(isDailyPayload({ ...valid(), prompt: "secret" })).toBe(false);
    expect(isDailyPayload({ ...valid(), constructor: "secret" })).toBe(false);
    expect(isDailyPayload({ ...valid(), undo: "3" })).toBe(false);
    expect(isDailyPayload({ ...valid(), payloadId: "not-a-uuid" })).toBe(false);
    expect(isDailyPayload({ ...valid(), runs: { ...valid().runs, byModel: { "claude-opus-5-5": 1 } } })).toBe(false);
    expect(isDailyPayload({ ...valid(), branching: { ...valid().branching, avgChildren: "2" } })).toBe(false);
  });

  it("rejects a payload above 8 KB", () => {
    const payload = valid();
    payload.runs.byRuntime = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`runtime-${"x".repeat(70)}${index}`.slice(0, 80), 1]));
    payload.nodesCreated = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`kind-${"y".repeat(70)}${index}`.slice(0, 80), 1]));
    expect(JSON.stringify(payload).length).toBeGreaterThan(8 * 1024);
    expect(isDailyPayload(payload)).toBe(false);
  });
});

describe("consent and sending days", () => {
  const stamp = (day: string) => new Date(`${day}T12:00:00`).getTime();
  const ledger: UsageLedger = { firstDay: "2026-10-01", days: Object.fromEntries(["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((day) => [day, emptyDay()])) };

  it("asks once from 25 successful runs while undecided", () => {
    expect(shouldAskForConsent({ successfulRuns: 24 })).toBe(false);
    expect(shouldAskForConsent({ successfulRuns: 25 })).toBe(true);
    expect(shouldAskForConsent({ successfulRuns: 90, consent: "declined" })).toBe(false);
  });

  it("sends nothing without a decision and nothing from before the consent day", () => {
    expect(daysToSend({}, ledger, "2026-10-17")).toEqual([]);
    expect(daysToSend({ decidedAt: stamp("2026-10-14") }, ledger, "2026-10-17")).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
  });

  it("skips sent days, excludes today and keeps at most 7 days", () => {
    expect(daysToSend({ decidedAt: stamp("2026-10-01"), lastSentDay: "2026-10-13" }, ledger, "2026-10-16")).toEqual(["2026-10-14", "2026-10-15"]);
    const long: UsageLedger = { firstDay: "2026-09-01", days: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [addDays("2026-10-01", index), emptyDay()])) };
    expect(daysToSend({ decidedAt: stamp("2026-09-01") }, long, "2026-10-20")).toHaveLength(7);
  });

  it("computes local days and day differences", () => {
    expect(localDayOf(stamp("2026-03-29"))).toBe("2026-03-29");
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("branching", () => {
  it("reports the longest ancestor chain and the widest fan-out and averages children over the nodes that have children, across boards", () => {
    const first = branchingOf(buildGraph(["a", "b", "c", "d", "e"], [["a", "b"], ["b", "c"], ["a", "d"], ["a", "e"]]));
    expect(first).toEqual({ maxDepth: 2, maxChildren: 3, parentNodes: 2, childLinks: 4 });
    const second = branchingOf(buildGraph(["a", "b"], [["a", "b"]]));
    expect(mergeBranching([first, second])).toEqual({ maxDepth: 2, maxChildren: 3, avgChildren: 1.67 });
  });

  it("is zero for an empty board", () => {
    expect(branchingOf(buildGraph([], []))).toEqual({ maxDepth: 0, maxChildren: 0, parentNodes: 0, childLinks: 0 });
    expect(mergeBranching([])).toEqual({ maxDepth: 0, maxChildren: 0, avgChildren: 0 });
  });
});

describe("normalizeDay", () => {
  it("fills every missing or malformed counter of a stored day", () => {
    const stored = { runs: { started: 2, byRuntime: { claude: 2, bad: "x" } }, undo: -1, activeBoardIds: ["a", 3] };
    expect(normalizeDay(stored)).toEqual({ ...emptyDay(), runs: { ...emptyDay().runs, started: 2, byRuntime: { claude: 2, bad: 0 } }, activeBoardIds: ["a"] });
    expect(normalizeDay(null)).toEqual(emptyDay());
  });
});
