import { BINDABLE_ACTIONS, type Keybinds } from "./keybinds";

export type ShortcutArea = "Board" | "Nodes" | "Selection" | "Canvas" | "Navigation";

export const SHORTCUT_AREAS: ShortcutArea[] = ["Board", "Nodes", "Selection", "Canvas", "Navigation"];

export type HeldModifier = "Ctrl" | "Alt" | "Shift";

export interface ShortcutRow {
  area: ShortcutArea;
  modifier?: HeldModifier;
  keys: string;
  text: string;
}

export const FIXED_SHORTCUTS: ShortcutRow[] = [
  { area: "Selection", modifier: "Ctrl", keys: "Click", text: "add to selection" },
  { area: "Selection", modifier: "Shift", keys: "Click", text: "add to selection" },
  { area: "Selection", modifier: "Shift", keys: "Drag", text: "box-select nodes" },
  { area: "Selection", modifier: "Ctrl", keys: "A", text: "select all nodes" },
  { area: "Nodes", modifier: "Ctrl", keys: "C / V", text: "copy / paste nodes" },
  { area: "Nodes", keys: "Delete", text: "delete the selected nodes" },
  { area: "Nodes", keys: "Escape", text: "stop the selected run" },
  { area: "Nodes", keys: "Enter", text: "send the prompt" },
  { area: "Nodes", modifier: "Shift", keys: "Enter", text: "new line in a prompt" },
  { area: "Canvas", keys: "Right-click", text: "menu for a node, board or selected text" },
  { area: "Navigation", keys: "Scroll / drag", text: "pan and zoom the board" },
];

export const rowKeys = (row: Pick<ShortcutRow, "modifier" | "keys">): string => [row.modifier, row.keys].filter(Boolean).join("+");

export const shortcutRows = (keybinds: Keybinds): ShortcutRow[] => {
  const bound = BINDABLE_ACTIONS.flatMap((action) => {
    const bindings = keybinds[action.id] ?? [];
    return bindings.length === 0 ? [] : [{ area: action.area, keys: (action.kind === "hold" ? bindings.map((binding) => `${binding}+Drag`) : bindings).join(" / "), text: action.label }];
  });
  const rows = [...bound, ...FIXED_SHORTCUTS.map((row) => ({ ...row, keys: rowKeys(row), modifier: undefined }))];
  return SHORTCUT_AREAS.flatMap((area) => rows.filter((row) => row.area === area));
};

export const SAMPLE_BOARD_TITLE = "Sample board";

export const SAMPLE_TITLES = {
  root: "Plan a CSV tool",
  python: "CSV tool in Python",
  node: "CSV tool in Node.js",
  stale: "Test for an empty file",
  compare: "Compare the versions",
  code: "converter.py",
} as const;

export interface TourStep {
  anchor: string;
  title: string;
  body: string;
  focusTitle?: string;
  selectsNode?: boolean;
}

export const TOUR_STEPS: TourStep[] = [
  {
    anchor: "node",
    focusTitle: SAMPLE_TITLES.root,
    title: "Chat turns are nodes",
    body: "A node holds one prompt and its answer. Add nodes from the toolbar at the bottom of the board.",
  },
  {
    anchor: "wire",
    title: "Wires set the context",
    body: "A node receives the nodes connected above it, in order. The note on the left is connected to both branches, so both follow its constraint.",
  },
  {
    anchor: "context-panel",
    focusTitle: SAMPLE_TITLES.python,
    selectsNode: true,
    title: "The context panel",
    body: "Select a node to see its parents, the turns sent with it and its token count. Drag a parent to change the order, or click × to disconnect it.",
  },
  {
    anchor: "stale",
    focusTitle: SAMPLE_TITLES.stale,
    title: "Stale answers",
    body: "The note above this node was edited after the answer was written, so the answer is marked stale. Regenerate the node to update it.",
  },
  {
    anchor: "branch",
    focusTitle: SAMPLE_TITLES.python,
    selectsNode: true,
    title: "Branch from any finished node",
    body: "Reply continues the thread. A new branch asks something else from the same point. To branch from part of an answer, select the text and right-click it.",
  },
  {
    anchor: "rolls",
    focusTitle: SAMPLE_TITLES.python,
    title: "Earlier answers",
    body: "Regenerating a node keeps its previous answers. Switch between them with the arrows. The selected answer is passed to the nodes below.",
  },
  {
    anchor: "code",
    focusTitle: SAMPLE_TITLES.code,
    title: "Code nodes",
    body: "A code node shows a file from the project folder and passes it to the nodes it is connected to. Add one from the toolbar or with the extract button next to a file path in an answer.",
  },
  {
    anchor: "table",
    focusTitle: SAMPLE_TITLES.compare,
    title: "Tables",
    body: "Click a column heading to sort a table. Download or copy it as CSV below the table.",
  },
  {
    anchor: "chart",
    focusTitle: SAMPLE_TITLES.compare,
    title: "Charts",
    body: "Agents can draw charts in their answers. A chart follows the light or dark theme and can be saved as a PNG.",
  },
  {
    anchor: "help",
    title: "Shortcuts and help",
    body: "Press Shift+? to list the shortcuts. Open this menu to see them or to take the tour again.",
  },
];
