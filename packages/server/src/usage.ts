import { join } from "node:path";
import { applyUsageEvent, emptyDay, localDayOf, normalizeDay, pruneDays, TELEMETRY_SCHEMA, type ConsentChoice, type DayFacts, type TelemetryState, type UsageEvent, type UsageLedger } from "@branchboard/core";
import { readJsonFile, writeJsonFile } from "./jsonFile";
import { log } from "./log";

export interface UsageRecorder {
  record: (event: UsageEvent) => void;
}

export interface UsageOptions {
  dataDirectory: string;
  clock?: () => number;
}

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

const consentOf = (value: unknown): ConsentChoice | undefined => (value === "granted" || value === "declined" ? value : undefined);

const countOf = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);

const dayOf = (value: unknown): string | undefined => (typeof value === "string" && DAY_FORMAT.test(value) ? value : undefined);

export const createUsage = ({ dataDirectory, clock = Date.now }: UsageOptions) => {
  const statePath = join(dataDirectory, "telemetry.json");
  const ledgerPath = join(dataDirectory, "usage", "days.json");
  const today = () => localDayOf(clock());

  const readState = (): TelemetryState => {
    const stored = readJsonFile<Record<string, unknown>>(statePath, {});
    return {
      schema: TELEMETRY_SCHEMA,
      consent: consentOf(stored.consent),
      decidedAt: typeof stored.decidedAt === "number" ? stored.decidedAt : undefined,
      decidedInVersion: typeof stored.decidedInVersion === "string" ? stored.decidedInVersion : undefined,
      successfulRuns: countOf(stored.successfulRuns),
      firstDay: dayOf(stored.firstDay) ?? today(),
      lastSentDay: dayOf(stored.lastSentDay),
      pendingPayload: pendingOf(stored.pendingPayload),
    };
  };

  const updateState = (changes: Partial<TelemetryState>): TelemetryState => {
    const next = { ...readState(), ...changes };
    writeJsonFile(statePath, next);
    return next;
  };

  const readLedger = (): UsageLedger => {
    const stored = readJsonFile<Partial<UsageLedger>>(ledgerPath, {});
    const days = typeof stored.days === "object" && stored.days !== null ? stored.days : {};
    return { firstDay: readState().firstDay, days: Object.fromEntries(Object.entries(days).map(([day, counters]) => [day, normalizeDay(counters)])) };
  };

  let cachedDays = readLedger().days;
  updateState({});

  const ledger = (): UsageLedger => ({ firstDay: readState().firstDay, days: cachedDays });

  const record = (event: UsageEvent) => {
    try {
      const day = today();
      const current = cachedDays[day] ?? emptyDay();
      const next = applyUsageEvent(current, event);
      const isSuccessfulRun = event.type === "run" && event.outcome === "done" && !event.stopped;
      if (isSuccessfulRun) updateState({ successfulRuns: readState().successfulRuns + 1 });
      if (next === current && cachedDays[day]) return;
      cachedDays = pruneDays({ ...cachedDays, [day]: next }, day);
      writeJsonFile(ledgerPath, { days: cachedDays });
    } catch (error) {
      log.warn("usage", "Could not record usage counts", error);
    }
  };

  const recordFacts = (day: string, facts: DayFacts) => {
    if (!cachedDays[day]) return;
    try {
      cachedDays = { ...cachedDays, [day]: { ...cachedDays[day], facts } };
      writeJsonFile(ledgerPath, { days: cachedDays });
    } catch (error) {
      log.warn("usage", "Could not record usage facts", error);
    }
  };

  return { record, recordFacts, ledger, state: readState, updateState, today };
};

const pendingOf = (value: unknown): TelemetryState["pendingPayload"] => {
  const candidate = value as { day?: unknown; payloadId?: unknown } | null | undefined;
  return candidate && dayOf(candidate.day) && typeof candidate.payloadId === "string" ? { day: candidate.day as string, payloadId: candidate.payloadId } : undefined;
};

export type Usage = ReturnType<typeof createUsage>;
