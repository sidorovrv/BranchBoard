import { redactDeep, type Id, type RedactionContext } from "@branchboard/core";
import { readJsonFile } from "./jsonFile";
import { readLogTail } from "./log";
import { LOG_SOURCES } from "./logSources";
import { filesNewestFirst, linesOf, MAX_REPORT_RECORDS, parsedRecordsOf, withoutPrompts } from "./report";
import type { ExtraTool } from "./runtimes/claudeApprovals";
import type { ChannelStatus } from "./channel";

export const DIAGNOSTICS_TOOL_NAME = "branchboard_diagnostics";
export const DIAGNOSTICS_SETTING = "agentDiagnosticsAccess";
export const CROSS_NODE_LOGS_SETTING = "agentCrossNodeLogs";

export const DIAGNOSTIC_SECTIONS = ["about", "runtimes", "models", "settings", "logs", "runs", "perf"] as const;

export type DiagnosticSection = (typeof DIAGNOSTIC_SECTIONS)[number];

export const isDiagnosticSection = (value: unknown): value is DiagnosticSection => DIAGNOSTIC_SECTIONS.includes(value as DiagnosticSection);

export interface DiagnosticCaller {
  boardId: Id;
  nodeId: Id;
}

export interface DiagnosticsSources {
  dataDirectory: string;
  version: string;
  settingsFile: string;
  channelStatus: () => ChannelStatus;
  runtimes: () => Promise<unknown>;
  models: () => Promise<unknown>;
  redaction: () => RedactionContext;
}

interface DiagnosticsRequest {
  filter?: string;
  caller?: DiagnosticCaller;
}

const LEVEL_PATTERN = /^(debug|info|warn|error)$/i;

const logFilterOf = (filter?: string) => (filter && LEVEL_PATTERN.test(filter) ? `${filter.toUpperCase().padEnd(5)} [` : filter || undefined);

const sourcePath = (dataDirectory: string, sourceId: string) => LOG_SOURCES.find((source) => source.id === sourceId)!.path(dataDirectory);

const matching = <T>(items: T[], filter?: string) => (filter ? items.filter((item) => (typeof item === "string" ? item : JSON.stringify(item)).includes(filter)) : items);

export const createDiagnostics = (sources: DiagnosticsSources) => {
  const settings = () => readJsonFile<Record<string, unknown>>(sources.settingsFile, {});
  const isOn = (key: string) => settings()[key] !== false;

  const runRecords = ({ filter, caller }: DiagnosticsRequest) => {
    const isScoped = caller !== undefined && !isOn(CROSS_NODE_LOGS_SETTING);
    const records = filesNewestFirst(sourcePath(sources.dataDirectory, "run-logs"))
      .flatMap((file) => parsedRecordsOf(linesOf(file)))
      .filter((record) => (record.event === "start" || record.event === "end") && (!isScoped || (record.boardId === caller.boardId && record.nodeId === caller.nodeId)))
      .map(withoutPrompts);
    return matching(records, filter).slice(-MAX_REPORT_RECORDS);
  };

  const readers: Record<DiagnosticSection, (request: DiagnosticsRequest) => unknown> = {
    about: () => ({
      version: sources.version,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      dataDirectory: sources.dataDirectory,
      environment: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("BRANCHBOARD_"))),
    }),
    runtimes: () => sources.runtimes(),
    models: async () => ({ runtimes: await sources.models(), channel: sources.channelStatus() }),
    settings: settings,
    logs: ({ filter }) => readLogTail(MAX_REPORT_RECORDS, logFilterOf(filter)),
    runs: runRecords,
    perf: ({ filter }) => {
      const [newest] = filesNewestFirst(sourcePath(sources.dataDirectory, "perf"));
      return newest ? matching(parsedRecordsOf(linesOf(newest)), filter).slice(-MAX_REPORT_RECORDS) : [];
    },
  };

  const collect = async (section: DiagnosticSection, request: DiagnosticsRequest = {}) => redactDeep(await readers[section](request), sources.redaction());

  return { version: sources.version, collect, isAgentAccessOn: () => isOn(DIAGNOSTICS_SETTING) };
};

export type Diagnostics = ReturnType<typeof createDiagnostics>;

export const diagnosticsNote = (version: string) => `You are running inside Branchboard ${version}. Call \`${DIAGNOSTICS_TOOL_NAME}\` for its models, settings, logs and runs.`;

export const createDiagnosticsTool = (diagnostics: Diagnostics, caller: DiagnosticCaller): ExtraTool => ({
  isEnabled: diagnostics.isAgentAccessOn,
  definition: {
    name: DIAGNOSTICS_TOOL_NAME,
    description: `Reads Branchboard's own state. Sections: ${DIAGNOSTIC_SECTIONS.join(", ")}. "filter" keeps log lines and records that contain the text; for logs it can also be a level (debug, info, warn, error).`,
    inputSchema: { type: "object", properties: { section: { type: "string", enum: [...DIAGNOSTIC_SECTIONS] }, filter: { type: "string" } }, required: ["section"] },
  },
  call: async ({ section, filter }) => {
    if (!isDiagnosticSection(section)) throw new Error(`Unknown section. Use one of: ${DIAGNOSTIC_SECTIONS.join(", ")}`);
    return diagnostics.collect(section, { filter: typeof filter === "string" ? filter : undefined, caller });
  },
});
