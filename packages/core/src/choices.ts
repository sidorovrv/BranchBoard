import type { Board, GraphNode } from "./types";

export const UNSET_CHOICE = "default";

export const RUN_CHOICE_DEFAULTS = {
  agent: "defaultAgent",
  model: "defaultModel",
  effort: "defaultEffort",
  permissionMode: "defaultPermissionMode",
} as const;

export type RunChoiceKey = keyof typeof RUN_CHOICE_DEFAULTS;

export const RUN_CHOICE_KEYS = Object.keys(RUN_CHOICE_DEFAULTS) as RunChoiceKey[];

export type RunChoices = Partial<Pick<GraphNode, RunChoiceKey>>;

export const isChosen = (value: string | undefined): value is string => Boolean(value) && value !== UNSET_CHOICE;

export const DEFAULT_MODEL_PREFERENCE = "sonnet";

export const preferredModelId = (models: { id: string }[], wanted: string): string | undefined => {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return undefined;
  return (models.find((model) => model.id.toLowerCase() === needle) ?? models.find((model) => model.id.toLowerCase().includes(needle)))?.id;
};

export const RUNTIME_DEFAULT_PERMISSION_MODE = "";

export const preferredPermissionMode = (modes: { id: string }[] | undefined, wanted: string): string | undefined =>
  wanted !== RUNTIME_DEFAULT_PERMISSION_MODE && modes?.some((mode) => mode.id === wanted) ? wanted : undefined;

export const inheritChoices = (explicit: RunChoices, source: RunChoices | undefined): RunChoices =>
  Object.fromEntries(RUN_CHOICE_KEYS.map((key) => [key, explicit[key] ?? source?.[key]]));

export const withBoardDefaults = (choices: RunChoices, board: Board): RunChoices =>
  Object.fromEntries(RUN_CHOICE_KEYS.map((key) => [key, choices[key] ?? board[RUN_CHOICE_DEFAULTS[key]]]));

export const rememberedDefaults = (node: RunChoices, board: Board): Partial<Board> =>
  Object.fromEntries(RUN_CHOICE_KEYS.map((key) => [RUN_CHOICE_DEFAULTS[key], node[key] ?? board[RUN_CHOICE_DEFAULTS[key]]]));
