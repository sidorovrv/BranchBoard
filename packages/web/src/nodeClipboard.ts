import { buildNodeClipboard, parseNodeClipboard, type Id } from "@branchboard/core";
import { sendBoardCommand, useBoard } from "./store";

export const isTextField = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return Boolean(element && (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable));
};

export const copySelectedNodes = (event: ClipboardEvent): boolean => {
  if (isTextField(event.target) || window.getSelection()?.toString()) return false;
  const { selectedIds, view, notify } = useBoard.getState();
  const clipboard = buildNodeClipboard(view.graph, view.parts, selectedIds);
  if (!clipboard || !event.clipboardData) return false;
  event.preventDefault();
  event.clipboardData.setData("text/plain", JSON.stringify(clipboard));
  notify(`Copied ${clipboard.nodes.length} ${clipboard.nodes.length === 1 ? "node" : "nodes"}. Paste on any board to duplicate.`);
  return true;
};

export const pasteCopiedNodes = async (event: ClipboardEvent, position: { x: number; y: number }): Promise<boolean> => {
  if (isTextField(event.target)) return false;
  const clipboard = parseNodeClipboard(event.clipboardData?.getData("text/plain") ?? "");
  if (!clipboard) return false;
  event.preventDefault();
  const pasted = await sendBoardCommand<{ nodeIds: Id[] }>({ type: "pasteNodes", clipboard, position });
  if (pasted) useBoard.getState().requestSelection(pasted.nodeIds);
  return true;
};
