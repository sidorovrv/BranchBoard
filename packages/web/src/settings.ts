import { create } from "zustand";
import { getJson } from "./api";
import { COST_WINDOWS, DEFAULT_MODEL_PREFERENCE, FLOW_DIRECTIONS, KEYBOARD_PAN_MODES, RUNTIME_DEFAULT_PERMISSION_MODE, NODE_HEIGHT, normaliseKeybinds, type CostWindowId, type FlowDirection, type KeyboardPanMode, type Keybinds, NODE_MAX_HEIGHT, NODE_MAX_WIDTH, NODE_MIN_HEIGHT, NODE_MIN_WIDTH, NODE_WIDTH } from "@branchboard/core";

export interface Settings {
  followScroll: boolean;
  defaultNodeWidth: number;
  defaultNodeHeight: number;
  blinkForAttention: boolean;
  snapNextPrompt: boolean;
  groupToolCalls: boolean;
  defaultModel: string;
  defaultPermissionMode: string;
  isSidebarOpen: boolean;
  isContextPanelOpen: boolean;
  readerWidth: number;
  answerFont: AnswerFont;
  theme: ThemeChoice;
  flowDirection: FlowDirection;
  subagentDisplay: SubagentDisplay;
  altClickZoom: number;
  keyboardPan: KeyboardPanMode;
  keyboardPanSpeed: number;
  showTopbarMeters: boolean;
  showClaudeCost: boolean;
  costWindows: CostWindowId[];
  agentDiagnosticsAccess: boolean;
  agentCrossNodeLogs: boolean;
  activeJobsShown: number;
  activeJobsStyle: ActiveJobsStyle;
  boardMemoryMinutes: number;
  shownTags: NodeTagId[];
  keybinds: Keybinds;
}

export const NODE_TAGS = [
  { id: "status", label: "Status" },
  { id: "summary", label: "Summary" },
  { id: "runTime", label: "Run time" },
  { id: "locked", label: "Locked" },
  { id: "assemble", label: "Assemble" },
  { id: "model", label: "Model" },
  { id: "agent", label: "Agent" },
  { id: "effort", label: "Effort" },
  { id: "permissionMode", label: "Permission mode" },
  { id: "contextMode", label: "Context mode" },
  { id: "contextChanged", label: "Context changed" },
  { id: "tokens", label: "Tokens" },
  { id: "cost", label: "Cost" },
  { id: "contextWindow", label: "Context window" },
  { id: "cache", label: "Prompt cache" },
] as const;

export type NodeTagId = (typeof NODE_TAGS)[number]["id"];

const ALL_NODE_TAGS: NodeTagId[] = NODE_TAGS.map((tag) => tag.id);

export const ACTIVE_JOBS_SHOWN_MAX = 20;
export const ACTIVE_JOBS_SHOWN_DEFAULT = 5;

export const BOARD_MEMORY_MINUTES_MAX = 60;
export const BOARD_MEMORY_MINUTES_DEFAULT = 10;

export const KEYBOARD_PAN_SPEED_MIN = 25;
export const KEYBOARD_PAN_SPEED_MAX = 500;
export const KEYBOARD_PAN_SPEED_DEFAULT = 100;

export const ALT_CLICK_ZOOM_MIN = 50;
export const ALT_CLICK_ZOOM_MAX = 100;
export const ALT_CLICK_ZOOM_DEFAULT = 85;

export type ActiveJobsStyle = "normal" | "mini";

export const ACTIVE_JOBS_STYLES: ActiveJobsStyle[] = ["normal", "mini"];

export type SubagentDisplay = "node" | "inline";

export const SUBAGENT_DISPLAYS: SubagentDisplay[] = ["node", "inline"];

export const READER_MIN_WIDTH = 320;
export const READER_MAX_WIDTH = 1100;
export const READER_DEFAULT_WIDTH = 460;

export type AnswerFont = "serif" | "sans";

export const ANSWER_FONTS: AnswerFont[] = ["serif", "sans"];

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_CHOICES: ThemeChoice[] = ["system", "light", "dark"];


export const DEFAULT_SETTINGS: Settings = { followScroll: true, defaultNodeWidth: NODE_WIDTH, defaultNodeHeight: NODE_HEIGHT, blinkForAttention: true, snapNextPrompt: false, groupToolCalls: false, defaultModel: DEFAULT_MODEL_PREFERENCE, defaultPermissionMode: RUNTIME_DEFAULT_PERMISSION_MODE, isSidebarOpen: true, isContextPanelOpen: false, readerWidth: READER_DEFAULT_WIDTH, answerFont: "sans", theme: "system", flowDirection: "horizontal", subagentDisplay: "node", altClickZoom: ALT_CLICK_ZOOM_DEFAULT, keyboardPan: "none", keyboardPanSpeed: KEYBOARD_PAN_SPEED_DEFAULT, showTopbarMeters: true, showClaudeCost: false, costWindows: ["hour"], agentDiagnosticsAccess: true, agentCrossNodeLogs: true, activeJobsShown: ACTIVE_JOBS_SHOWN_DEFAULT, activeJobsStyle: "normal", boardMemoryMinutes: BOARD_MEMORY_MINUTES_DEFAULT, shownTags: ALL_NODE_TAGS, keybinds: normaliseKeybinds({}) };

const STORAGE_KEY = "branchboard.settings";
const OVERRIDE_KEY = "branchboard.settingsOverride";
const SETTINGS_PATH = "/api/settings";

type SettingNormalizers = { [K in keyof Settings]: (value: unknown) => Settings[K] };

const normalizers: SettingNormalizers = {
  followScroll: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.followScroll),
  defaultNodeWidth: (value) => {
    const width = Number(value);
    return Number.isFinite(width) ? Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, Math.round(width))) : DEFAULT_SETTINGS.defaultNodeWidth;
  },
  blinkForAttention: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.blinkForAttention),
  snapNextPrompt: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.snapNextPrompt),
  groupToolCalls: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.groupToolCalls),
  defaultNodeHeight: (value) => {
    const height = Number(value);
    return Number.isFinite(height) ? Math.min(NODE_MAX_HEIGHT, Math.max(NODE_MIN_HEIGHT, Math.round(height))) : DEFAULT_SETTINGS.defaultNodeHeight;
  },
  defaultModel: (value) => (typeof value === "string" ? value : DEFAULT_SETTINGS.defaultModel),
  defaultPermissionMode: (value) => (typeof value === "string" && /^[A-Za-z]{0,40}$/.test(value) ? value : DEFAULT_SETTINGS.defaultPermissionMode),
  isSidebarOpen: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.isSidebarOpen),
  isContextPanelOpen: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.isContextPanelOpen),
  readerWidth: (value) => {
    const width = Number(value);
    return Number.isFinite(width) ? Math.min(READER_MAX_WIDTH, Math.max(READER_MIN_WIDTH, Math.round(width))) : DEFAULT_SETTINGS.readerWidth;
  },
  answerFont: (value) => (ANSWER_FONTS.includes(value as AnswerFont) ? (value as AnswerFont) : DEFAULT_SETTINGS.answerFont),
  theme: (value) => (THEME_CHOICES.includes(value as ThemeChoice) ? (value as ThemeChoice) : DEFAULT_SETTINGS.theme),
  flowDirection: (value) => (FLOW_DIRECTIONS.includes(value as FlowDirection) ? (value as FlowDirection) : DEFAULT_SETTINGS.flowDirection),
  subagentDisplay: (value) => (SUBAGENT_DISPLAYS.includes(value as SubagentDisplay) ? (value as SubagentDisplay) : DEFAULT_SETTINGS.subagentDisplay),
  altClickZoom: (value) => {
    const percent = Number(value);
    return Number.isFinite(percent) ? Math.min(ALT_CLICK_ZOOM_MAX, Math.max(ALT_CLICK_ZOOM_MIN, Math.round(percent))) : DEFAULT_SETTINGS.altClickZoom;
  },
  keyboardPan: (value) => (KEYBOARD_PAN_MODES.includes(value as KeyboardPanMode) ? (value as KeyboardPanMode) : DEFAULT_SETTINGS.keyboardPan),
  keyboardPanSpeed: (value) => {
    const percent = Number(value);
    return Number.isFinite(percent) ? Math.min(KEYBOARD_PAN_SPEED_MAX, Math.max(KEYBOARD_PAN_SPEED_MIN, Math.round(percent))) : DEFAULT_SETTINGS.keyboardPanSpeed;
  },
  showTopbarMeters: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.showTopbarMeters),
  showClaudeCost: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.showClaudeCost),
  costWindows: (value) => (Array.isArray(value) ? COST_WINDOWS.map((window) => window.id).filter((id) => value.includes(id)) : DEFAULT_SETTINGS.costWindows),
  agentDiagnosticsAccess: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.agentDiagnosticsAccess),
  agentCrossNodeLogs: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.agentCrossNodeLogs),
  activeJobsShown: (value) => {
    const count = Number(value);
    return Number.isFinite(count) ? Math.min(ACTIVE_JOBS_SHOWN_MAX, Math.max(0, Math.round(count))) : DEFAULT_SETTINGS.activeJobsShown;
  },
  activeJobsStyle: (value) => (ACTIVE_JOBS_STYLES.includes(value as ActiveJobsStyle) ? (value as ActiveJobsStyle) : DEFAULT_SETTINGS.activeJobsStyle),
  boardMemoryMinutes: (value) => {
    const minutes = Number(value);
    return Number.isFinite(minutes) ? Math.min(BOARD_MEMORY_MINUTES_MAX, Math.max(0, Math.round(minutes))) : DEFAULT_SETTINGS.boardMemoryMinutes;
  },
  shownTags: (value) => (Array.isArray(value) ? ALL_NODE_TAGS.filter((id) => value.includes(id)) : DEFAULT_SETTINGS.shownTags),
  keybinds: normaliseKeybinds,
};

const normalize = (raw: Partial<Record<keyof Settings, unknown>>): Settings => ({
  followScroll: normalizers.followScroll(raw.followScroll),
  defaultNodeWidth: normalizers.defaultNodeWidth(raw.defaultNodeWidth),
  defaultNodeHeight: normalizers.defaultNodeHeight(raw.defaultNodeHeight),
  snapNextPrompt: normalizers.snapNextPrompt(raw.snapNextPrompt),
  groupToolCalls: normalizers.groupToolCalls(raw.groupToolCalls),
  blinkForAttention: normalizers.blinkForAttention(raw.blinkForAttention),
  defaultModel: normalizers.defaultModel(raw.defaultModel),
  defaultPermissionMode: normalizers.defaultPermissionMode(raw.defaultPermissionMode),
  isSidebarOpen: normalizers.isSidebarOpen(raw.isSidebarOpen),
  isContextPanelOpen: normalizers.isContextPanelOpen(raw.isContextPanelOpen),
  readerWidth: normalizers.readerWidth(raw.readerWidth),
  answerFont: normalizers.answerFont(raw.answerFont),
  theme: normalizers.theme(raw.theme),
  flowDirection: normalizers.flowDirection(raw.flowDirection),
  subagentDisplay: normalizers.subagentDisplay(raw.subagentDisplay),
  altClickZoom: normalizers.altClickZoom(raw.altClickZoom),
  keyboardPan: normalizers.keyboardPan(raw.keyboardPan),
  keyboardPanSpeed: normalizers.keyboardPanSpeed(raw.keyboardPanSpeed),
  showTopbarMeters: normalizers.showTopbarMeters(raw.showTopbarMeters),
  showClaudeCost: normalizers.showClaudeCost(raw.showClaudeCost),
  costWindows: normalizers.costWindows(raw.costWindows),
  agentDiagnosticsAccess: normalizers.agentDiagnosticsAccess(raw.agentDiagnosticsAccess),
  agentCrossNodeLogs: normalizers.agentCrossNodeLogs(raw.agentCrossNodeLogs),
  activeJobsShown: normalizers.activeJobsShown(raw.activeJobsShown),
  activeJobsStyle: normalizers.activeJobsStyle(raw.activeJobsStyle),
  boardMemoryMinutes: normalizers.boardMemoryMinutes(raw.boardMemoryMinutes),
  shownTags: normalizers.shownTags(raw.shownTags),
  keybinds: normalizers.keybinds(raw.keybinds),
});

export type ResolvedTheme = "light" | "dark";

const systemPrefersDark = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export const resolveTheme = (choice: ThemeChoice): ResolvedTheme => (choice === "system" ? (systemPrefersDark() ? "dark" : "light") : choice);

const readStoredObject = (key: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const settingsOverride = () => readStoredObject(OVERRIDE_KEY);

const load = (): Settings => normalize({ ...readStoredObject(STORAGE_KEY), ...settingsOverride() });

const save = (settings: Settings) => {
  if (settingsOverride()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    return;
  } finally {
    void fetch(SETTINGS_PATH, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) }).catch(() => undefined);
  }
};

export const loadServerSettings = async (): Promise<void> => {
  try {
    const stored = await getJson<Record<string, unknown> | null>(SETTINGS_PATH);
    if (stored) useSettings.setState({ settings: normalize({ ...stored, ...settingsOverride() }) });
    else if (localStorage.getItem(STORAGE_KEY) !== null) save(useSettings.getState().settings);
  } catch {
    return;
  }
};

interface SettingsStore {
  settings: Settings;
  update: <K extends keyof Settings>(key: K, value: unknown) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: load(),
  update: (key, value) => {
    const settings = { ...get().settings, [key]: normalizers[key](value) };
    save(settings);
    set({ settings });
  },
  reset: () => {
    save(DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });
  },
}));
