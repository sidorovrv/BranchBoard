import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { commentsPrompt, MAX_COMMENT_CHARS, newId, type GraphNode, type NodeComment } from "@branchboard/core";
import { createAndFocus } from "../actions";
import { keepNativeMenuOnTextFields } from "./ContextMenu";
import { ANSWER_SELECTOR, commentsOfRoll, rangeOfComment } from "../commentAnchors";
import { listenForEscape } from "../escape";
import { sendBoardCommand, useBoard } from "../store";
import { Icon } from "../kit/Icons";

export interface CommentAnchor {
  nodeId: string;
  roll: number;
  start: number;
  end: number;
  quote: string;
}

export const addComment = ({ nodeId, ...position }: CommentAnchor, text: string) => sendBoardCommand({ type: "editComments", nodeId, add: { id: newId(), ...position, text } });

const changeComment = (nodeId: string, id: string, text: string) => sendBoardCommand({ type: "editComments", nodeId, update: { id, text } });

const removeComment = (nodeId: string, removeId: string) => sendBoardCommand({ type: "editComments", nodeId, removeId });

interface CommentFieldProps {
  initialText?: string;
  label: string;
  autoFocus?: boolean;
  onSubmit: (text: string) => void;
  onAsk?: (text: string) => void;
}

export const askNow = ({ nodeId, quote }: Pick<CommentAnchor, "nodeId" | "quote">, text: string) =>
  createAndFocus({ type: "reply", parentIds: [nodeId], prompt: commentsPrompt([{ quote, text }]) });

export const CommentField = ({ initialText = "", label, autoFocus, onSubmit, onAsk }: CommentFieldProps) => {
  const [text, setText] = useState(initialText);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);
  const isBlank = text.trim() === "";
  const submit = () => !isBlank && onSubmit(text.trim());
  return (
    <div className={`comment-field${onAsk ? " has-actions" : ""}`}>
      <textarea
        ref={input}
        rows={1}
        autoFocus={autoFocus}
        maxLength={MAX_COMMENT_CHARS}
        value={text}
        placeholder="Add a comment"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          submit();
        }}
      />
      {onAsk ? (
        <div className="comment-actions">
          <button disabled={isBlank} onClick={submit} title={label}>{initialText ? "Save comment" : "Add to comments"}</button>
          <button className="primary" disabled={isBlank} onClick={() => onAsk(text.trim())} title="Send the quote and the comment to a new node and run it now">Ask now</button>
        </div>
      ) : (
        <button className="comment-submit" disabled={isBlank} onClick={submit} title={label} aria-label={label}><Icon name="comment" /></button>
      )}
    </div>
  );
};

interface OpenComment {
  x: number;
  y: number;
  nodeId: string;
  commentId: string;
}

const isInsideRects = (range: Range, x: number, y: number): boolean =>
  [...range.getClientRects()].some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);

const commentAt = (event: MouseEvent): { nodeId: string; comment: NodeComment } | undefined => {
  const answer = (event.target as Element | null)?.closest<HTMLElement>(ANSWER_SELECTOR);
  const nodeId = answer?.closest(".react-flow__node")?.getAttribute("data-id");
  const node: GraphNode | undefined = nodeId ? useBoard.getState().view.graph.nodes[nodeId] : undefined;
  if (!answer || !nodeId || !node) return undefined;
  const hits = commentsOfRoll(node, Number(answer.dataset.roll)).filter((comment) => {
    const range = rangeOfComment(answer, comment);
    return range !== undefined && isInsideRects(range, event.clientX, event.clientY);
  });
  const narrowest = hits.sort((left, right) => left.end - left.start - (right.end - right.start))[0];
  return narrowest ? { nodeId, comment: narrowest } : undefined;
};

export const CommentMenu = () => {
  const [open, setOpen] = useState<OpenComment>();
  const comment = useBoard((state) => (open ? state.view.graph.nodes[open.nodeId]?.comments?.find((item) => item.id === open.commentId) : undefined));

  useEffect(() => {
    const openAtClick = (event: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      const hit = commentAt(event);
      if (hit) setOpen({ x: event.clientX, y: event.clientY, nodeId: hit.nodeId, commentId: hit.comment.id });
    };
    document.addEventListener("click", openAtClick);
    return () => document.removeEventListener("click", openAtClick);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(undefined);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    const stopListeningForEscape = listenForEscape(close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      stopListeningForEscape();
    };
  }, [open]);

  if (!open || !comment) return null;
  const close = () => setOpen(undefined);
  return (
    <div className="context-menu comment-menu" style={{ left: open.x, top: open.y }} onMouseDown={(event) => event.stopPropagation()} onContextMenu={keepNativeMenuOnTextFields}>
      <blockquote className="comment-quote">{comment.quote}</blockquote>
      <CommentField key={comment.id} initialText={comment.text} label="Save the comment" autoFocus onSubmit={(text) => (close(), void changeComment(open.nodeId, comment.id, text))} onAsk={(text) => (close(), void removeComment(open.nodeId, comment.id), void askNow({ nodeId: open.nodeId, quote: comment.quote }, text))} />
      <button className="danger" onClick={() => (close(), void removeComment(open.nodeId, comment.id))}>Delete comment</button>
    </div>
  );
};
