import {
  checkEdit,
  childIdsOf,
  describeContext,
  estimateChildRepublication,
  estimateRepublication,
  boundActionId,
  clickBindingOf,
  exclusiveDescendantIds,
  formatTokens,
  isSidePointerButton,
  keyBindingOf,
  parentIdsOf,
  shortcutLabelOf,
  type GraphEdit,
  type GraphNode,
  type Keybinds,
} from "@branchboard/core";
import { createFileNode, pickFiles } from "./attachments";
import type { IconName } from "./kit/Icons";
import { displayShortcuts } from "./platform";
import { useSettings } from "./settings";
import { sendBoardCommand, useBoard } from "./store";

export interface ActionContext {
  node?: GraphNode;
  at?: { x: number; y: number };
}

const placedAt = ({ at }: ActionContext) => (at ? { nearPosition: at } : {});

export interface Action {
  id: string;
  label: (context: ActionContext) => string;
  icons: (context: ActionContext) => IconName[];
  hint?: (context: ActionContext) => string;
  isActive?: (context: ActionContext) => boolean;
  scope: "node" | "global";
  isAvailable: (context: ActionContext) => boolean;
  run: (context: ActionContext) => void | Promise<unknown>;
}

const graph = () => useBoard.getState().view.graph;

const SETTLED = ["done", "error", "interrupted"];

const isSettledTurn = ({ node }: ActionContext): boolean => node?.kind === "turn" && SETTLED.includes(node.status);

const hasChildren = ({ node }: ActionContext): boolean => node !== undefined && childIdsOf(graph(), node.id).length > 0;

export const createAndFocus = async (command: Record<string, unknown>) => {
  const created = await sendBoardCommand<{ nodeId: string }>(command);
  if (created) {
    useBoard.getState().requestFocus(created.nodeId);
  }
};

export const openNewBoard = async (boardId: string) => {
  await useBoard.getState().loadBoards();
  await useBoard.getState().openBoard(boardId);
  await createAndFocus({ type: "reply", parentIds: [] });
};

const republishHint =(tokens: number): string => (tokens === 0 ? "" : `republishes ~${formatTokens(tokens)} tokens of context`);

const childHint = (_context: ActionContext, parentIds: string[]): string => republishHint(estimateChildRepublication(graph(), useBoard.getState().view.parts, parentIds));

const inPlaceHint = ({ node }: ActionContext): string => republishHint(describeContext(graph(), useBoard.getState().view.parts, node!.id).republished);

const describeRepublication = (edit: GraphEdit): string | undefined => {
  const lines = estimateRepublication(graph(), useBoard.getState().view.parts, edit)
    .filter((entry) => entry.tokens > 0 || entry.staleCount > 0)
    .map((entry) => {
      const stale = entry.staleCount > 0 ? `, ${entry.staleCount} ${entry.staleCount === 1 ? "answer goes" : "answers go"} stale` : "";
      return `“${graph().nodes[entry.nodeId].title}” will re-send ~${formatTokens(entry.tokens)} tokens of context${stale}`;
    });
  return lines.length > 0 ? lines.join("; ") : undefined;
};

export const commitGraphEdit = async (edit: GraphEdit) => {
  const { notify } = useBoard.getState();
  const reason = checkEdit(graph(), edit);
  if (reason) return notify(reason);
  const summary = describeRepublication(edit);
  const result = await sendBoardCommand(edit);
  if (result && summary) notify(summary);
};

export const summariseNode = async ({ node }: ActionContext) => {
  const { notify } = useBoard.getState();
  notify("Summarising…");
  const result = await sendBoardCommand({ type: "summarise", nodeId: node!.id });
  if (result) notify("Summary saved");
};

export const actions: Action[] = [
  {
    id: "reply",
    label: (context) => (hasChildren(context) ? "Branch" : "Reply"),
    icons: (context) => [hasChildren(context) ? "branch" : "reply"],
    hint: (context) => childHint(context, [context.node!.id]),
    scope: "node",
    isAvailable: (context) => isSettledTurn(context) || context.node?.kind === "code",
    run: ({ node }) => createAndFocus({ type: "reply", parentIds: [node!.id] }),
  },
  {
    id: "edit",
    label: () => "Edit",
    icons: () => ["edit"],
    hint: inPlaceHint,
    scope: "node",
    isAvailable: isSettledTurn,
    run: ({ node }) => sendBoardCommand({ type: "reopen", nodeId: node!.id }),
  },
  {
    id: "editAndBranch",
    label: () => "Edit & branch",
    icons: () => ["edit", "branch"],
    hint: (context) => childHint(context, parentIdsOf(graph(), context.node!.id)),
    scope: "node",
    isAvailable: isSettledTurn,
    run: ({ node }) => createAndFocus({ type: "sibling", originalId: node!.id, run: false }),
  },
  {
    id: "regenerate",
    label: () => "Regenerate",
    icons: () => ["regenerate"],
    hint: inPlaceHint,
    scope: "node",
    isAvailable: isSettledTurn,
    run: ({ node }) => sendBoardCommand({ type: "regenerate", nodeId: node!.id }),
  },
  {
    id: "regenerateAndBranch",
    label: () => "Regenerate & branch",
    icons: () => ["regenerate", "branch"],
    hint: (context) => childHint(context, parentIdsOf(graph(), context.node!.id)),
    scope: "node",
    isAvailable: isSettledTurn,
    run: ({ node }) => createAndFocus({ type: "sibling", originalId: node!.id }),
  },
  {
    id: "stop",
    label: () => "Stop",
    icons: () => ["stop"],
    scope: "node",
    isAvailable: ({ node }) => node !== undefined && ["queued", "running", "awaiting_approval"].includes(node.status),
    run: ({ node }) => sendBoardCommand({ type: "abort", nodeId: node!.id }),
  },
  {
    id: "assemble",
    label: ({ node }) => (node?.forceAssemble ? "Use session" : "Assemble context"),
    icons: () => ["assemble"],
    isActive: ({ node }) => node?.forceAssemble === true,
    hint: ({ node }) => (node?.forceAssemble ? "on, context goes as text" : "off, parent session is reused"),
    scope: "node",
    isAvailable: ({ node }) => node?.kind === "turn" && node.status === "idle",
    run: ({ node }) => sendBoardCommand({ type: "editNode", nodeId: node!.id, fields: { forceAssemble: !node!.forceAssemble } }),
  },
  {
    id: "summarise",
    label: () => "Summarise up to here",
    icons: () => ["summary"],
    hint: () => "short stand-in for this turn and earlier ones",
    scope: "node",
    isAvailable: ({ node }) => node?.kind === "turn" && node.status === "done",
    run: summariseNode,
  },
  {
    id: "compact",
    label: () => "Compact session",
    icons: () => ["summary"],
    hint: () => "shrink the saved session of this turn",
    scope: "node",
    isAvailable: ({ node }) => node?.kind === "turn" && node.status === "done" && node.runtimeRef !== undefined && useBoard.getState().catalog?.canCompact === true,
    run: async ({ node }) => {
      const { notify } = useBoard.getState();
      notify("Compacting…");
      const result = await sendBoardCommand({ type: "compactNode", nodeId: node!.id });
      if (result) notify("Session compacted");
    },
  },
  {
    id: "pin",
    label: ({ node }) => (node?.pinned ? "Unpin" : "Pin"),
    icons: ({ node }) => [node?.pinned ? "unpin" : "pin"],
    hint: ({ node }) => (node?.pinned ? "allow moving and resizing" : "lock position and size"),
    isActive: ({ node }) => node?.pinned === true,
    scope: "node",
    isAvailable: ({ node }) => node !== undefined,
    run: ({ node }) => sendBoardCommand({ type: "pin", nodeId: node!.id }),
  },
  {
    id: "collapse",
    label: ({ node }) => (node?.collapsed ? "Expand" : "Collapse"),
    icons: ({ node }) => [node?.collapsed ? "expand" : "collapse"],
    scope: "node",
    isAvailable: hasChildren,
    run: ({ node }) => sendBoardCommand({ type: "collapse", nodeId: node!.id }),
  },
  {
    id: "delete",
    label: () => "Delete",
    icons: () => ["delete"],
    scope: "node",
    isAvailable: ({ node }) => node !== undefined,
    run: ({ node }) => sendBoardCommand({ type: "deleteNodes", ids: [node!.id] }),
  },
  {
    id: "deleteTree",
    label: () => "Delete with branch",
    icons: () => ["delete", "branch"],
    scope: "node",
    isAvailable: ({ node }) => node !== undefined && exclusiveDescendantIds(graph(), [node.id]).size > 0,
    run: ({ node }) => sendBoardCommand({ type: "deleteNodes", ids: [node!.id], withExclusiveDescendants: true }),
  },
  {
    id: "undo",
    label: () => "Undo",
    icons: () => ["undo"],
    scope: "global",
    isAvailable: () => true,
    run: () => sendBoardCommand({ type: "undo" }),
  },
  {
    id: "redo",
    label: () => "Redo",
    icons: () => ["redo"],
    scope: "global",
    isAvailable: () => true,
    run: () => sendBoardCommand({ type: "redo" }),
  },
  {
    id: "newChat",
    label: () => "New chat node",
    icons: () => ["plus"],
    scope: "global",
    isAvailable: () => true,
    run: (context) => createAndFocus({ type: "reply", parentIds: [], ...placedAt(context) }),
  },
  {
    id: "newNote",
    label: () => "New note",
    icons: () => ["note"],
    scope: "global",
    isAvailable: () => true,
    run: (context) => createAndFocus({ type: "note", ...placedAt(context) }),
  },
  {
    id: "newCode",
    label: () => "New code node",
    icons: () => ["code"],
    scope: "global",
    isAvailable: () => true,
    run: (context) => createAndFocus({ type: "code", ...placedAt(context) }),
  },
  {
    id: "newFile",
    label: () => "New file node",
    icons: () => ["paperclip"],
    scope: "global",
    isAvailable: () => true,
    run: async ({ at }) => createFileNode(await pickFiles(), at),
  },
  {
    id: "reader",
    label: () => (useBoard.getState().isReaderOpen ? "Close the reader" : "Open the reader"),
    icons: () => ["reader"],
    scope: "global",
    isAvailable: () => true,
    run: () => useBoard.getState().setReaderOpen(!useBoard.getState().isReaderOpen),
  },
  {
    id: "search",
    label: () => "Search inside nodes",
    icons: () => ["search"],
    scope: "global",
    isAvailable: () => true,
    run: () => {
      const input = document.querySelector<HTMLInputElement>(".search-panel input");
      if (input) return input.select();
      useSettings.getState().update("isContextPanelOpen", true);
      useBoard.getState().setSidePanelTab("search");
    },
  },
  {
    id: "showShortcuts",
    label: () => "Show the shortcuts",
    icons: () => ["help"],
    scope: "global",
    isAvailable: () => true,
    run: () => useBoard.getState().setShortcutsOpen(!useBoard.getState().isShortcutsOpen),
  },
];

export const actionById = (id: string): Action => actions.find((action) => action.id === id)!;

export const availableNodeActions = (node: GraphNode): Action[] => actions.filter((action) => action.scope === "node" && action.isAvailable({ node }));

const currentKeybinds = (): Keybinds => useSettings.getState().settings.keybinds;

export const titleWithShortcut = (actionId: string, keybinds: Keybinds): string => {
  const shortcuts = displayShortcuts(shortcutLabelOf(keybinds, actionId));
  const label = actionById(actionId).label({});
  return shortcuts ? `${label} (${shortcuts})` : label;
};

const pointerActionIdOf = (event: MouseEvent): string | undefined => {
  const binding = clickBindingOf(event);
  return binding ? boundActionId(currentKeybinds(), binding) : undefined;
};

export const isFocusClick = (event: MouseEvent): boolean => pointerActionIdOf(event) === "focusNode";

const runGlobalAction = (actionId: string | undefined): boolean => {
  const action = actions.find((candidate) => candidate.scope === "global" && candidate.id === actionId);
  if (!action) return false;
  void action.run({});
  return true;
};

const stopSelectedRun = (target: HTMLElement | null): boolean => {
  const { selectedIds, view } = useBoard.getState();
  const node = selectedIds.length === 1 ? view.graph.nodes[selectedIds[0]] : undefined;
  const stop = actions.find((candidate) => candidate.id === "stop")!;
  if (!target?.closest(".react-flow") || !stop.isAvailable({ node })) return false;
  void stop.run({ node });
  return true;
};

export const handleShortcut = (event: KeyboardEvent): boolean => {
  if (useBoard.getState().isTourOpen || event.defaultPrevented) return false;
  const target = event.target as HTMLElement | null;
  const isTyping = Boolean(target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable));
  if (event.key === "Escape" && !isTyping && stopSelectedRun(target)) return true;
  const pressed = keyBindingOf(event);
  const actionId = pressed ? boundActionId(currentKeybinds(), pressed) : undefined;
  if (isTyping && !(actionId === "search" && pressed?.startsWith("Ctrl+"))) return false;
  if (!runGlobalAction(actionId)) return false;
  event.preventDefault();
  return true;
};

export const shortcutCapture = { isActive: false };

export const isBoundSidePointer = (event: MouseEvent): boolean => isSidePointerButton(event.button) && pointerActionIdOf(event) !== undefined;

export const handleSidePointer = (event: MouseEvent, focusNode: (nodeId: string) => void): boolean => {
  if (shortcutCapture.isActive || !isBoundSidePointer(event)) return false;
  event.preventDefault();
  if (pointerActionIdOf(event) !== "focusNode") return runGlobalAction(pointerActionIdOf(event));
  const nodeId = (event.target as HTMLElement | null)?.closest(".react-flow__node")?.getAttribute("data-id");
  if (nodeId) focusNode(nodeId);
  return true;
};
