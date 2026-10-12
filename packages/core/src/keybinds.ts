export type BindingKind = "key" | "click";

export interface BindableAction {
  id: string;
  label: string;
  kind: BindingKind;
  defaults: string[];
  area: "Board" | "Nodes" | "Selection" | "Canvas" | "Navigation";
}

export type Keybinds = Record<string, string[]>;

export interface ModifierState {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface KeyInput extends ModifierState {
  key: string;
  code?: string;
}

export interface PointerInput extends ModifierState {
  button: number;
}

export const CLICK_NAME = "Click";

const POINTER_NAMES_BY_BUTTON: Record<number, string> = { 0: CLICK_NAME, 1: "MiddleClick", 3: "Mouse4", 4: "Mouse5" };
const POINTER_NAMES = Object.values(POINTER_NAMES_BY_BUTTON);

export const BINDABLE_ACTIONS: BindableAction[] = [
  { id: "undo", label: "Undo", kind: "key", defaults: ["Ctrl+Z"], area: "Board" },
  { id: "redo", label: "Redo", kind: "key", defaults: ["Ctrl+Shift+Z", "Ctrl+Y"], area: "Board" },
  { id: "newChat", label: "New chat node", kind: "key", defaults: ["Alt+N"], area: "Nodes" },
  { id: "newNote", label: "New note", kind: "key", defaults: ["Alt+M"], area: "Nodes" },
  { id: "newCode", label: "New code node", kind: "key", defaults: ["Alt+C"], area: "Nodes" },
  { id: "newFile", label: "New file node", kind: "key", defaults: ["Alt+F"], area: "Nodes" },
  { id: "reader", label: "Open or close the reader", kind: "key", defaults: ["Alt+R"], area: "Navigation" },
  { id: "search", label: "Search inside nodes", kind: "key", defaults: ["Ctrl+F"], area: "Navigation" },
  { id: "focusNode", label: "Zoom in on a node", kind: "click", defaults: ["Alt+Click"], area: "Canvas" },
  { id: "showShortcuts", label: "Show the shortcuts", kind: "key", defaults: ["Shift+?"], area: "Navigation" },
];

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift"];
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph"]);
const SPECIAL_KEY_NAMES: Record<string, string> = { " ": "Space", "+": "Plus" };
const RESERVED_BINDINGS: Record<string, string> = {
  "Ctrl+C": "copying nodes",
  "Ctrl+V": "pasting nodes",
  "Ctrl+A": "selecting all nodes",
  Delete: "deleting nodes",
  Backspace: "deleting nodes",
  "Ctrl+Click": "adding to the selection",
  "Shift+Click": "adding to the selection",
};

const actionOf = (id: string): BindableAction | undefined => BINDABLE_ACTIONS.find((action) => action.id === id);

const keyNameOf = ({ key, code }: KeyInput): string => {
  const letter = /^Key([A-Z])$/.exec(code ?? "");
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code ?? "");
  if (digit) return digit[1];
  if (key.length === 1) return SPECIAL_KEY_NAMES[key] ?? key.toUpperCase();
  return key;
};

const joinBinding = (state: ModifierState, name: string): string =>
  [state.ctrlKey || state.metaKey ? "Ctrl" : "", state.altKey ? "Alt" : "", state.shiftKey ? "Shift" : "", name].filter(Boolean).join("+");

export const keyBindingOf = (input: KeyInput): string | undefined => (MODIFIER_KEYS.has(input.key) ? undefined : joinBinding(input, keyNameOf(input)));

export const clickBindingOf = (input: PointerInput): string | undefined => {
  const name = POINTER_NAMES_BY_BUTTON[input.button];
  return name ? joinBinding(input, name) : undefined;
};

export const isSidePointerButton = (button: number): boolean => button !== 0 && POINTER_NAMES_BY_BUTTON[button] !== undefined;

export const modifiersOfBinding = (binding: string): string[] => binding.split("+").slice(0, -1);

export const keyOfBinding = (binding: string): string => binding.split("+").at(-1) ?? "";

const isValidBinding = (binding: string, kind: BindingKind): boolean => {
  const modifiers = modifiersOfBinding(binding);
  const name = keyOfBinding(binding);
  const isCanonical = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)).join("+") === modifiers.join("+");
  if (!name || !isCanonical) return false;
  if (kind === "click") return POINTER_NAMES.includes(name) && (name !== CLICK_NAME || modifiers.length > 0);
  return name !== CLICK_NAME;
};

export const normaliseKeybinds = (raw: unknown): Keybinds => {
  const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    BINDABLE_ACTIONS.map((action) => {
      const value = stored[action.id];
      if (!Array.isArray(value)) return [action.id, action.defaults];
      const valid = value.filter((binding): binding is string => typeof binding === "string" && isValidBinding(binding, action.kind));
      return [action.id, [...new Set(valid)]];
    }),
  );
};

export const boundActionId = (keybinds: Keybinds, binding: string): string | undefined => BINDABLE_ACTIONS.find((action) => keybinds[action.id]?.includes(binding))?.id;

export const bindingProblem = (keybinds: Keybinds, actionId: string, binding: string): string | undefined => {
  if (RESERVED_BINDINGS[binding]) return `${binding} is reserved for ${RESERVED_BINDINGS[binding]}`;
  if (keybinds[actionId]?.includes(binding)) return `${binding} is already added here`;
  return undefined;
};

export const sharedBindingOwners = (keybinds: Keybinds, actionId: string): Record<string, string[]> => {
  const shared: Record<string, string[]> = {};
  for (const binding of keybinds[actionId] ?? []) {
    const others = BINDABLE_ACTIONS.filter((action) => action.id !== actionId && keybinds[action.id]?.includes(binding)).map((action) => action.label);
    if (others.length > 0) shared[binding] = others;
  }
  return shared;
};

export const isDefaultBinding = (keybinds: Keybinds, actionId: string): boolean => {
  const current = keybinds[actionId] ?? [];
  const defaults = actionOf(actionId)?.defaults ?? [];
  return current.length === defaults.length && current.every((binding, index) => binding === defaults[index]);
};

export const shortcutLabelOf = (keybinds: Keybinds, actionId: string): string => (keybinds[actionId] ?? []).join(" / ");
