import { create } from "zustand";
import { DEFAULT_MODEL_PREFERENCE, FLOW_DIRECTIONS, KEYBOARD_PAN_MODES, RUNTIME_DEFAULT_PERMISSION_MODE, NODE_HEIGHT, normaliseKeybinds, type FlowDirection, type KeyboardPanMode, type Keybinds, NODE_MAX_HEIGHT, NODE_MAX_WIDTH, NODE_MIN_HEIGHT, NODE_MIN_WIDTH, NODE_WIDTH } from "@branchboard/core";

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
  boardNavigation: BoardNavigation;
  showTopbarMeters: boolean;
  activeJobsShown: number;
  keybinds: Keybinds;
}

export const ACTIVE_JOBS_SHOWN_MAX = 20;
export const ACTIVE_JOBS_SHOWN_DEFAULT = 5;

export type BoardNavigation = "sidebar" | "tabs" | "both";

export const BOARD_NAVIGATIONS: BoardNavigation[] = ["sidebar", "tabs", "both"];

export const KEYBOARD_PAN_SPEED_MIN = 25;
export const KEYBOARD_PAN_SPEED_MAX = 500;
export const KEYBOARD_PAN_SPEED_DEFAULT = 100;

export const ALT_CLICK_ZOOM_MIN = 50;
export const ALT_CLICK_ZOOM_MAX = 100;
export const ALT_CLICK_ZOOM_DEFAULT = 85;

export type SubagentDisplay = "node" | "inline";

export const SUBAGENT_DISPLAYS: SubagentDisplay[] = ["node", "inline"];

export const READER_MIN_WIDTH = 320;
export const READER_MAX_WIDTH = 1100;
export const READER_DEFAULT_WIDTH = 460;

export type AnswerFont = "serif" | "sans";

export const ANSWER_FONTS: AnswerFont[] = ["serif", "sans"];

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_CHOICES: ThemeChoice[] = ["system", "light", "dark"];


export const DEFAULT_SETTINGS: Settings = { followScroll: true, defaultNodeWidth: NODE_WIDTH, defaultNodeHeight: NODE_HEIGHT, blinkForAttention: true, snapNextPrompt: false, groupToolCalls: false, defaultModel: DEFAULT_MODEL_PREFERENCE, defaultPermissionMode: RUNTIME_DEFAULT_PERMISSION_MODE, isSidebarOpen: true, isContextPanelOpen: true, readerWidth: READER_DEFAULT_WIDTH, answerFont: "sans", theme: "system", flowDirection: "horizontal", subagentDisplay: "node", altClickZoom: ALT_CLICK_ZOOM_DEFAULT, keyboardPan: "none", keyboardPanSpeed: KEYBOARD_PAN_SPEED_DEFAULT, boardNavigation: "sidebar", showTopbarMeters: true, activeJobsShown: ACTIVE_JOBS_SHOWN_DEFAULT, keybinds: normaliseKeybinds({}) };

const STORAGE_KEY = "branchboard.settings";

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
  boardNavigation: (value) => (BOARD_NAVIGATIONS.includes(value as BoardNavigation) ? (value as BoardNavigation) : DEFAULT_SETTINGS.boardNavigation),
  showTopbarMeters: (value) => (typeof value === "boolean" ? value : DEFAULT_SETTINGS.showTopbarMeters),
  activeJobsShown: (value) => {
    const count = Number(value);
    return Number.isFinite(count) ? Math.min(ACTIVE_JOBS_SHOWN_MAX, Math.max(0, Math.round(count))) : DEFAULT_SETTINGS.activeJobsShown;
  },
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
  boardNavigation: normalizers.boardNavigation(raw.boardNavigation),
  showTopbarMeters: normalizers.showTopbarMeters(raw.showTopbarMeters),
  activeJobsShown: normalizers.activeJobsShown(raw.activeJobsShown),
  keybinds: normalizers.keybinds(raw.keybinds),
});

export type ResolvedTheme = "light" | "dark";

const systemPrefersDark = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export const resolveTheme = (choice: ThemeChoice): ResolvedTheme => (choice === "system" ? (systemPrefersDark() ? "dark" : "light") : choice);

const load = (): Settings => {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return DEFAULT_SETTINGS;
  }
};

const save = (settings: Settings) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
