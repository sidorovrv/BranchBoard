import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEMO_SCRIPT_PATH = ".branchboard/demo-script.json";

export type DemoStep =
  | { type: "reasoning"; text: string }
  | { type: "tool"; description: string; output?: string; delayMs?: number }
  | { type: "chunk"; text: string; charsPerSecond?: number }
  | { type: "file-write"; path: string; content: string }
  | { type: "pause"; delayMs: number };

export interface DemoEntry {
  speed: number;
  steps: DemoStep[];
}

export type DemoScript = Record<string, DemoEntry>;

const STEP_TYPES = new Set(["reasoning", "tool", "chunk", "file-write", "pause"]);

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

const parseEntry = (key: string, raw: unknown): DemoEntry => {
  const entry = (Array.isArray(raw) ? { steps: raw } : raw) as { speed?: unknown; steps?: unknown } | null;
  if (!entry || !Array.isArray(entry.steps)) throw new Error(`Entry "${key}" needs a "steps" list`);
  if (entry.speed !== undefined && (typeof entry.speed !== "number" || !(entry.speed > 0))) throw new Error(`Entry "${key}": "speed" must be a positive number`);
  entry.steps.forEach((step: { type?: unknown }, index) => {
    if (!step || typeof step.type !== "string" || !STEP_TYPES.has(step.type)) throw new Error(`Entry "${key}", step ${index + 1}: unknown type "${String(step?.type)}"`);
  });
  return { speed: (entry.speed as number | undefined) ?? 1, steps: entry.steps as DemoStep[] };
};

export const parseDemoScript = (source: string): DemoScript => {
  const raw = JSON.parse(source) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The script must be an object keyed by prompt");
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [normalize(key), parseEntry(key, value)]));
};

export const loadDemoScript = (workspacePath: string): DemoScript | undefined => {
  const path = join(workspacePath, DEMO_SCRIPT_PATH);
  if (!existsSync(path)) return undefined;
  try {
    return parseDemoScript(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Demo script ${DEMO_SCRIPT_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const matchDemoEntry = (script: DemoScript, input: string): DemoEntry | undefined => {
  const lines = input.split("\n").filter((line) => line.trim() !== "");
  const unquoted = lines.filter((line) => !line.startsWith(">"));
  const endings = lines.map((_, count) => normalize(lines.slice(lines.length - 1 - count).join("\n")));
  const candidates = [normalize(input), normalize(unquoted.join("\n")), ...endings];
  for (const candidate of candidates) if (candidate && script[candidate]) return script[candidate];
  return undefined;
};
