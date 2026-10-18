import { liveEdges, liveNodes } from "./graph";
import { RECOVERY_IDS } from "./recovery";
import { TELEMETRY_SCHEMA } from "./telemetrySchema";
import type { BoardGraph, Id } from "./types";

export * from "./telemetrySchema";

export const ASK_AFTER_SUCCESSFUL_RUNS = 25;
export const LEDGER_DAYS = 60;
export const MAX_DAYS_PER_SEND = 7;
export const OTHER_BUCKET = "other";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Counts = Record<string, number>;
export type ConsentChoice = "granted" | "declined";
export type RunOutcome = "done" | "error" | "interrupted";

export interface RunCounters {
  started: number;
  done: number;
  error: number;
  interrupted: number;
  stopped: number;
  regenerations: number;
  byRuntime: Counts;
  byContextMode: Counts;
  failuresByRecovery: Counts;
}

export interface DayFacts {
  boardsTotal: number;
  branching: Branching;
}

export interface DayCounters {
  nodesCreated: Counts;
  runs: RunCounters;
  boardsCreated: number;
  undo: number;
  activeBoardIds: Id[];
  facts?: DayFacts;
}

export interface UsageLedger {
  firstDay: string;
  days: Record<string, DayCounters>;
}

export type UsageEvent =
  | { type: "run"; boardId: Id; outcome: RunOutcome; stopped: boolean; runtime: string; contextMode?: string; recovery?: string; isRegeneration: boolean }
  | { type: "nodeCreated"; boardId: Id; kind: string }
  | { type: "boardCreated"; boardId: Id }
  | { type: "edit"; boardId: Id }
  | { type: "undo"; boardId: Id };

export interface Branching {
  maxDepth: number;
  maxChildren: number;
  avgChildren: number;
}

export interface BranchingTotals {
  maxDepth: number;
  maxChildren: number;
  parentNodes: number;
  childLinks: number;
}

export interface TelemetryFacts {
  payloadId: string;
  version: string;
  os: string;
  nodeMajor: number;
  boardsTotal: number;
  branching: Branching;
}

export interface DailyPayload {
  schema: typeof TELEMETRY_SCHEMA;
  payloadId: string;
  day: string;
  app: { version: string; os: string; nodeMajor: number };
  retention: { installAgeDays: number; daysActiveLast7: number; daysActiveLast28: number };
  boards: { total: number; created: number; active: number };
  nodesCreated: Counts;
  runs: RunCounters;
  branching: Branching;
  undo: number;
}

export interface TelemetryTile {
  group: string;
  label: string;
  value: string | number;
}

export interface TelemetryState {
  schema: number;
  consent?: ConsentChoice;
  decidedAt?: number;
  decidedInVersion?: string;
  successfulRuns: number;
  firstDay: string;
  lastSentDay?: string;
  pendingPayload?: { day: string; payloadId: string };
}

export interface TelemetryOverview {
  consent: ConsentChoice | null;
  shouldAsk: boolean;
  preview: DailyPayload;
  sentLogPath: string;
}

const pad = (value: number) => String(value).padStart(2, "0");

export const localDayOf = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const dayNumber = (day: string): number => {
  const [year, month, date] = day.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, date) / DAY_MS);
};

const dayOfNumber = (value: number): string => new Date(value * DAY_MS).toISOString().slice(0, 10);

export const addDays = (day: string, count: number): string => dayOfNumber(dayNumber(day) + count);

export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

const emptyRuns = (): RunCounters => ({ started: 0, done: 0, error: 0, interrupted: 0, stopped: 0, regenerations: 0, byRuntime: {}, byContextMode: {}, failuresByRecovery: {} });

export const emptyDay = (): DayCounters => ({ nodesCreated: {}, runs: emptyRuns(), boardsCreated: 0, undo: 0, activeBoardIds: [] });

const recordOf = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

const countOf = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);

const countsOf = (value: unknown): Counts => Object.fromEntries(Object.entries(recordOf(value)).map(([key, count]) => [key, countOf(count)]));

const decimalOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

const factsOf = (value: unknown): DayFacts | undefined => {
  const stored = recordOf(value);
  if (stored.boardsTotal === undefined) return undefined;
  const branching = recordOf(stored.branching);
  return { boardsTotal: countOf(stored.boardsTotal), branching: { maxDepth: countOf(branching.maxDepth), maxChildren: countOf(branching.maxChildren), avgChildren: decimalOf(branching.avgChildren) } };
};

export const normalizeDay = (value: unknown): DayCounters => {
  const stored = recordOf(value);
  const runs = recordOf(stored.runs);
  const facts = factsOf(stored.facts);
  return {
    nodesCreated: countsOf(stored.nodesCreated),
    runs: {
      started: countOf(runs.started),
      done: countOf(runs.done),
      error: countOf(runs.error),
      interrupted: countOf(runs.interrupted),
      stopped: countOf(runs.stopped),
      regenerations: countOf(runs.regenerations),
      byRuntime: countsOf(runs.byRuntime),
      byContextMode: countsOf(runs.byContextMode),
      failuresByRecovery: countsOf(runs.failuresByRecovery),
    },
    boardsCreated: countOf(stored.boardsCreated),
    undo: countOf(stored.undo),
    activeBoardIds: Array.isArray(stored.activeBoardIds) ? stored.activeBoardIds.filter((id): id is Id => typeof id === "string") : [],
    ...(facts ? { facts } : {}),
  };
};

const bump = (counts: Counts, key: string | undefined): Counts => (key === undefined ? counts : { ...counts, [key]: (counts[key] ?? 0) + 1 });

const withActiveBoard = (day: DayCounters, boardId: Id): DayCounters => (day.activeBoardIds.includes(boardId) ? day : { ...day, activeBoardIds: [...day.activeBoardIds, boardId] });

const recoveryKeyOf = (recovery: string | undefined): string => (RECOVERY_IDS.includes(recovery as (typeof RECOVERY_IDS)[number]) ? (recovery as string) : OTHER_BUCKET);

const applyRun = (runs: RunCounters, event: Extract<UsageEvent, { type: "run" }>): RunCounters => ({
  ...runs,
  started: runs.started + 1,
  [event.outcome]: runs[event.outcome] + 1,
  stopped: runs.stopped + (event.stopped ? 1 : 0),
  regenerations: runs.regenerations + (event.isRegeneration ? 1 : 0),
  byRuntime: bump(runs.byRuntime, event.runtime),
  byContextMode: bump(runs.byContextMode, event.contextMode),
  failuresByRecovery: event.outcome === "error" ? bump(runs.failuresByRecovery, recoveryKeyOf(event.recovery)) : runs.failuresByRecovery,
});

export const applyUsageEvent = (day: DayCounters, event: UsageEvent): DayCounters => {
  const active = withActiveBoard(day, event.boardId);
  if (event.type === "run") return { ...active, runs: applyRun(active.runs, event) };
  if (event.type === "nodeCreated") return { ...active, nodesCreated: bump(active.nodesCreated, event.kind) };
  if (event.type === "boardCreated") return { ...active, boardsCreated: active.boardsCreated + 1 };
  if (event.type === "undo") return { ...active, undo: active.undo + 1 };
  return active;
};

export const pruneDays = (days: UsageLedger["days"], today: string): UsageLedger["days"] =>
  Object.fromEntries(Object.entries(days).filter(([day]) => daysBetween(day, today) < LEDGER_DAYS));

export const branchingOf = (graph: BoardGraph): BranchingTotals => {
  const nodeIds = new Set(liveNodes(graph).map((node) => node.id));
  const edges = liveEdges(graph).filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId));
  const parents = new Map<Id, Id[]>();
  const children = new Map<Id, number>();
  edges.forEach((edge) => {
    parents.set(edge.toId, [...(parents.get(edge.toId) ?? []), edge.fromId]);
    children.set(edge.fromId, (children.get(edge.fromId) ?? 0) + 1);
  });
  const depths = new Map<Id, number>();
  const depthOf = (id: Id): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const depth = Math.max(0, ...(parents.get(id) ?? []).map((parent) => depthOf(parent) + 1));
    depths.set(id, depth);
    return depth;
  };
  return {
    maxDepth: Math.max(0, ...[...nodeIds].map(depthOf)),
    maxChildren: Math.max(0, ...children.values()),
    parentNodes: children.size,
    childLinks: [...children.values()].reduce((sum, count) => sum + count, 0),
  };
};

const sumOf = (parts: BranchingTotals[], pick: (part: BranchingTotals) => number): number => parts.reduce((sum, part) => sum + pick(part), 0);

export const mergeBranching = (parts: BranchingTotals[]): Branching => {
  const parentNodes = sumOf(parts, (part) => part.parentNodes);
  return {
    maxDepth: Math.max(0, ...parts.map((part) => part.maxDepth)),
    maxChildren: Math.max(0, ...parts.map((part) => part.maxChildren)),
    avgChildren: parentNodes === 0 ? 0 : Math.round((sumOf(parts, (part) => part.childLinks) / parentNodes) * 100) / 100,
  };
};

const withoutZeros = (counts: Counts): Counts => Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));

const activeDaysWithin = (ledger: UsageLedger, day: string, window: number): number =>
  Object.keys(ledger.days).filter((candidate) => daysBetween(candidate, day) >= 0 && daysBetween(candidate, day) < window).length;

export const buildDailyPayload = (day: string, ledger: UsageLedger, facts: TelemetryFacts): DailyPayload => {
  const counters = ledger.days[day] ?? emptyDay();
  const { runs } = counters;
  return {
    schema: TELEMETRY_SCHEMA,
    payloadId: facts.payloadId,
    day,
    app: { version: facts.version, os: facts.os, nodeMajor: facts.nodeMajor },
    retention: { installAgeDays: Math.max(0, daysBetween(ledger.firstDay, day)), daysActiveLast7: activeDaysWithin(ledger, day, 7), daysActiveLast28: activeDaysWithin(ledger, day, 28) },
    boards: { total: facts.boardsTotal, created: counters.boardsCreated, active: counters.activeBoardIds.length },
    nodesCreated: withoutZeros(counters.nodesCreated),
    runs: {
      ...runs,
      byRuntime: withoutZeros(runs.byRuntime),
      byContextMode: withoutZeros(runs.byContextMode),
      failuresByRecovery: withoutZeros(runs.failuresByRecovery),
    },
    branching: facts.branching,
    undo: counters.undo,
  };
};

const tilesOfCounts = (group: string, counts: Counts, label: (key: string) => string = (key) => key): TelemetryTile[] =>
  Object.entries(counts).map(([key, value]) => ({ group, label: label(key), value }));

export const telemetryTiles = (payload: DailyPayload): TelemetryTile[] => {
  const { app, retention, boards, runs, branching } = payload;
  return [
    { group: "App", label: "Version", value: app.version },
    { group: "App", label: "System", value: app.os },
    { group: "App", label: "Node.js", value: app.nodeMajor },
    { group: "Activity", label: "Runs today", value: runs.started },
    { group: "Activity", label: "Finished", value: runs.done },
    { group: "Activity", label: "Failed", value: runs.error },
    { group: "Activity", label: "Interrupted", value: runs.interrupted },
    { group: "Activity", label: "Stopped", value: runs.stopped },
    { group: "Activity", label: "Regenerations", value: runs.regenerations },
    { group: "Activity", label: "Undo steps", value: payload.undo },
    { group: "Activity", label: "Days since first use", value: retention.installAgeDays },
    { group: "Activity", label: "Active days, last 7", value: retention.daysActiveLast7 },
    { group: "Activity", label: "Active days, last 28", value: retention.daysActiveLast28 },
    { group: "Boards", label: "Boards", value: boards.total },
    { group: "Boards", label: "Created today", value: boards.created },
    { group: "Boards", label: "Active today", value: boards.active },
    { group: "Boards", label: "Deepest branch", value: branching.maxDepth },
    { group: "Boards", label: "Max. branches of a node", value: branching.maxChildren },
    { group: "Boards", label: "Avg. branches of a node", value: branching.avgChildren },
    ...tilesOfCounts("Nodes created today", payload.nodesCreated),
    ...tilesOfCounts("Runtimes", runs.byRuntime, (key) => `Runs on ${key}`),
    ...tilesOfCounts("Context", runs.byContextMode),
    ...tilesOfCounts("Failures", runs.failuresByRecovery),
  ];
};

export const shouldAskForConsent = (state: Pick<TelemetryState, "consent" | "successfulRuns">): boolean => state.consent === undefined && state.successfulRuns >= ASK_AFTER_SUCCESSFUL_RUNS;

export const daysToSend = (state: Pick<TelemetryState, "decidedAt" | "lastSentDay">, ledger: UsageLedger, today: string): string[] => {
  if (state.decidedAt === undefined) return [];
  const consentDay = localDayOf(state.decidedAt);
  return Object.keys(ledger.days)
    .filter((day) => day >= consentDay && day < today && (state.lastSentDay === undefined || day > state.lastSentDay))
    .sort()
    .slice(-MAX_DAYS_PER_SEND);
};
