import type { LaunchProcess } from "./spawnProcess";

export interface SupportedModel {
  id: string;
  name: string;
  efforts?: string[];
}

const REQUEST_ID = "branchboard-initialize";
const PROBE_TIMEOUT_MS = 10_000;
const MAX_MODELS = 60;

const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= 120 ? value : undefined);

export const parseSupportedModels = (line: string): SupportedModel[] | undefined => {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (message?.type !== "control_response" || message.response?.request_id !== REQUEST_ID) return undefined;
  const raw = message.response?.response?.models;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_MODELS).flatMap((entry): SupportedModel[] => {
    const id = textOf(entry?.value);
    if (!id || id === "default") return [];
    const levels = Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.filter((level: unknown): level is string => typeof level === "string") : [];
    return [{ id, name: textOf(entry.displayName) ?? id, ...(levels.length > 0 ? { efforts: levels } : {}) }];
  });
};

const firstSupportedModels = async (lines: AsyncIterable<string>): Promise<SupportedModel[]> => {
  for await (const line of lines) {
    const models = parseSupportedModels(line);
    if (models) return models;
  }
  return [];
};

export const probeSupportedModels = async (launch: LaunchProcess, executable: string, cwd: string, env: NodeJS.ProcessEnv): Promise<SupportedModel[]> => {
  const running = launch(executable, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], { cwd, env });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("The claude command did not answer the model request in time")), PROBE_TIMEOUT_MS)));
  try {
    running.writeInput(`${JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "initialize" } })}\n`);
    return await Promise.race([firstSupportedModels(running.lines), timeout]);
  } finally {
    clearTimeout(timer);
    running.endInput();
    running.kill();
  }
};
