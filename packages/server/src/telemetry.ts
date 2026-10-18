import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  branchingOf,
  buildDailyPayload,
  daysToSend,
  isDailyPayload,
  mergeBranching,
  shouldAskForConsent,
  type Branching,
  type DailyPayload,
  type DayFacts,
  type Id,
  type TelemetryFacts,
  type TelemetryOverview,
} from "@branchboard/core";
import type { BoardService } from "./boards";
import { fetchRemote } from "./fetchRemote";
import { appendJsonLine } from "./jsonFile";
import { log } from "./log";
import type { Usage } from "./usage";

export const TELEMETRY_URL = "https://branchboard-telemetry.branchboard.workers.dev/v1/daily";

export interface PostResult {
  status: number;
}

export type PostPayload = (url: string, body: string) => Promise<PostResult>;

export interface TelemetryOptions {
  dataDirectory: string;
  usage: Usage;
  boards: BoardService;
  version: string;
  isOffline: () => boolean;
  post?: PostPayload;
  url?: string;
  clock?: () => number;
}

const postWithFetch: PostPayload = async (url, body) => {
  const response = await fetchRemote(url, { method: "POST", body, headers: { "content-type": "application/json" } });
  return { status: response.status };
};

export const telemetryUrl = (): string => process.env.BRANCHBOARD_TELEMETRY_URL || TELEMETRY_URL;

export const createTelemetry = ({ dataDirectory, usage, boards, version, isOffline, post = postWithFetch, url, clock = Date.now }: TelemetryOptions) => {
  const sentLogPath = join(dataDirectory, "telemetry-sent.jsonl");
  let sending: Promise<void> | undefined;

  const branchingOfDay = (boardIds: Id[]): Branching =>
    mergeBranching(
      boardIds.flatMap((boardId) => {
        try {
          return [branchingOf(boards.stateOf(boardId).graph)];
        } catch {
          return [];
        }
      }),
    );

  const currentFacts = (day: string): DayFacts => ({ boardsTotal: boards.listBoards().length, branching: branchingOfDay(usage.ledger().days[day]?.activeBoardIds ?? []) });

  const snapshotToday = () => {
    const day = usage.today();
    usage.recordFacts(day, currentFacts(day));
  };

  const factsFor = async (day: string, payloadId: string): Promise<TelemetryFacts> => ({
    payloadId,
    version,
    os: process.platform,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    ...(day < usage.today() ? (usage.ledger().days[day]?.facts ?? currentFacts(day)) : currentFacts(day)),
  });

  const payloadFor = async (day: string, payloadId: string = randomUUID()): Promise<DailyPayload> => buildDailyPayload(day, usage.ledger(), await factsFor(day, payloadId));

  const overview = async (): Promise<TelemetryOverview> => {
    const state = usage.state();
    return { consent: state.consent ?? null, shouldAsk: shouldAskForConsent(state), preview: await payloadFor(usage.today()), sentLogPath };
  };

  const setConsent = (isGranted: boolean) => {
    usage.updateState({ consent: isGranted ? "granted" : "declined", decidedAt: clock(), decidedInVersion: version, pendingPayload: undefined });
    log.info("telemetry", isGranted ? "Usage statistics enabled" : "Usage statistics disabled");
  };

  const sendDay = async (day: string): Promise<boolean> => {
    const pending = usage.state().pendingPayload;
    const payloadId: string = pending?.day === day ? pending.payloadId : randomUUID();
    usage.updateState({ pendingPayload: { day, payloadId } });
    const payload = await payloadFor(day, payloadId);
    if (!isDailyPayload(payload)) {
      log.warn("telemetry", `The payload for ${day} does not match the schema and is not sent`);
      return false;
    }
    const body = JSON.stringify(payload);
    const sentAt = new Date(clock()).toISOString();
    try {
      const { status } = await post(url ?? telemetryUrl(), body);
      appendJsonLine(sentLogPath, { sentAt, status, payload });
      if (status < 200 || status >= 300) return false;
      usage.updateState({ lastSentDay: day, pendingPayload: undefined });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendJsonLine(sentLogPath, { sentAt, status: null, error: message, payload });
      log.debug("telemetry", `Could not send the statistics for ${day}: ${message}`);
      return false;
    }
  };

  const sendAll = async () => {
    snapshotToday();
    const state = usage.state();
    if (state.consent !== "granted" || isOffline()) return;
    for (const day of daysToSend(state, usage.ledger(), usage.today())) {
      if (usage.state().consent !== "granted" || !(await sendDay(day))) return;
    }
  };

  const sendPendingDays = (): Promise<void> => {
    sending ??= sendAll()
      .catch((error) => log.warn("telemetry", "Sending usage statistics failed", error))
      .finally(() => {
        sending = undefined;
      });
    return sending;
  };

  return { overview, setConsent, sendPendingDays, sentLogPath };
};

export type Telemetry = ReturnType<typeof createTelemetry>;
