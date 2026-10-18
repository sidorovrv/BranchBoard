import { useEffect, useMemo, useState } from "react";
import { activeRollOf, bulletOfQuote, isBranchList, liveNodes, quotedPrompt, withAddedBullet, type GraphNode } from "@branchboard/core";
import { createAndFocus } from "../actions";
import { keepNativeMenuOnTextFields } from "./ContextMenu";
import { ANSWER_SELECTOR, offsetsOfRange } from "../commentAnchors";
import { sendBoardCommand, useBoard } from "../store";
import { addComment, askNow, CommentField, type CommentAnchor } from "./Comments";

interface Selection {
  nodeId: string;
  text: string;
  range: Range;
  comment?: CommentAnchor;
}

interface OpenMenu {
  x: number;
  y: number;
  selection: Selection;
}

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

declare const Highlight: new (...ranges: Range[]) => unknown;

const MAX_QUOTE_CHARS = 2000;
const HIGHLIGHT_NAME = "branch-selection";
const LIST_PREVIEW_CHARS = 48;
const SUBMENU_ROOM = 560;

const highlights = (): HighlightRegistry | undefined => (CSS as unknown as { highlights?: HighlightRegistry }).highlights;

const showHighlight = (range: Range | undefined) => {
  if (!range) return highlights()?.delete(HIGHLIGHT_NAME);
  highlights()?.set(HIGHLIGHT_NAME, new Highlight(range));
};

const readSelection = (): Selection | undefined => {
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!selection || !text || selection.rangeCount === 0) return undefined;
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
  if (!anchor?.closest(".copyable")) return undefined;
  const nodeId = anchor.closest(".react-flow__node")?.getAttribute("data-id");
  const node = nodeId ? useBoard.getState().view.graph.nodes[nodeId] : undefined;
  const isBranchable = node?.kind === "code" || (node?.kind === "turn" && node.status !== "idle");
  if (!nodeId || !isBranchable) return undefined;
  const range = selection.getRangeAt(0).cloneRange();
  return { nodeId, text: text.slice(0, MAX_QUOTE_CHARS), range, comment: commentAnchorOf(anchor, node, range, text.slice(0, MAX_QUOTE_CHARS)) };
};

const commentAnchorOf = (anchor: Element, node: GraphNode, range: Range, quote: string): CommentAnchor | undefined => {
  const answer = anchor.closest<HTMLElement>(ANSWER_SELECTOR);
  if (!answer || !answer.contains(range.commonAncestorContainer)) return { nodeId: node.id, roll: activeRollOf(node), quote, start: 0, end: 0 };
  return { nodeId: node.id, roll: Number(answer.dataset.roll), quote, ...offsetsOfRange(answer, range) };
};

const branchFromSelection = ({ nodeId, text }: Selection) => createAndFocus({ type: "reply", parentIds: [nodeId], prompt: quotedPrompt(text), run: false });

const newBranchList = ({ nodeId, text }: Selection) => createAndFocus({ type: "reply", parentIds: [nodeId], prompt: bulletOfQuote(text), run: false });

const saveAsNote = ({ nodeId, text }: Selection) => createAndFocus({ type: "note", prompt: text, originId: nodeId });

const copyText = ({ text }: Selection) => void navigator.clipboard.writeText(text).catch(() => undefined);

const addToBranchList = async (target: GraphNode, { text }: Selection) => {
  const updated = await sendBoardCommand({ type: "editNode", nodeId: target.id, fields: { prompt: withAddedBullet(target.prompt, text) } });
  if (updated) useBoard.getState().requestFocus(target.id);
};

const openBranchLists = (): GraphNode[] => liveNodes(useBoard.getState().view.graph).filter((node) => node.kind === "turn" && node.status === "idle" && isBranchList(node.prompt));

const listLabel = (node: GraphNode): string => {
  const firstLine = node.prompt.split("\n")[0];
  const preview = firstLine.length > LIST_PREVIEW_CHARS ? `${firstLine.slice(0, LIST_PREVIEW_CHARS)}…` : firstLine;
  return `${node.title}: ${preview}`;
};

export const SelectionMenu = () => {
  const [menu, setMenu] = useState<OpenMenu>();
  const lists = useMemo(() => (menu ? openBranchLists() : []), [menu]);

  const close = () => setMenu(undefined);

  useEffect(() => {
    const open = (event: MouseEvent) => {
      const selection = readSelection();
      if (!selection) return;
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, selection });
    };
    document.addEventListener("contextmenu", open);
    return () => document.removeEventListener("contextmenu", open);
  }, []);

  useEffect(() => {
    if (!menu) return;
    showHighlight(menu.selection.range);
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      showHighlight(undefined);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  if (!menu) return null;
  const opensLeft = menu.x > window.innerWidth - SUBMENU_ROOM;
  const choose = (run: (selection: Selection) => unknown) => () => {
    close();
    void run(menu.selection);
  };
  return (
    <div className="context-menu selection-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()} onContextMenu={keepNativeMenuOnTextFields}>
      {menu.selection.comment && (
        <>
          <CommentField
            autoFocus
            label="Add the comment to the selected text"
            onSubmit={(text) => (close(), window.getSelection()?.removeAllRanges(), void addComment(menu.selection.comment!, text))}
            onAsk={(text) => (close(), window.getSelection()?.removeAllRanges(), void askNow(menu.selection.comment!, text))}
          />
          <hr />
        </>
      )}
      <button onClick={choose(branchFromSelection)} title="New node under this one, starting with the selection as a quote">Quick branch</button>
      <button onClick={choose(newBranchList)} title="New node under this one, starting a bullet list with the selection">New branch list</button>
      <div className="selection-menu-parent">
        <button disabled={lists.length === 0} title={lists.length === 0 ? "No open branch list on this board" : "Append the selection to a list that has not run yet"}>
          Add to branch list{lists.length > 0 ? " ›" : ""}
        </button>
        {lists.length > 0 && (
          <div className={`context-menu selection-submenu${opensLeft ? " opens-left" : ""}`}>
            {lists.map((target) => (
              <button key={target.id} className="selection-menu-list" onClick={() => (close(), void addToBranchList(target, menu.selection))} title={listLabel(target)}>{listLabel(target)}</button>
            ))}
          </div>
        )}
      </div>
      <hr />
      <button onClick={choose(saveAsNote)} title="Keep the selection as a note that can feed any node">Save as note</button>
      <button onClick={choose(copyText)}>Copy</button>
    </div>
  );
};
