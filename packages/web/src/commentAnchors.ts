import { useEffect } from "react";
import type { GraphNode, NodeComment } from "@branchboard/core";

export const ANSWER_SELECTOR = "[data-roll]";
const HIGHLIGHT_NAME = "node-comment";

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

declare const Highlight: new (...ranges: Range[]) => unknown;

const registry = (): HighlightRegistry | undefined => (CSS as unknown as { highlights?: HighlightRegistry }).highlights;

const withoutSpaces = (text: string): string => text.replace(/\s+/g, "");

const textNodesOf = (root: Element): Text[] => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) nodes.push(current as Text);
  return nodes;
};

export const offsetsOfRange = (root: Element, range: Range): { start: number; end: number } => {
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + range.toString().length };
};

export const rangeAtOffsets = (root: Element, start: number, end: number): Range | undefined => {
  const range = document.createRange();
  let position = 0;
  let isStartSet = false;
  for (const text of textNodesOf(root)) {
    const length = text.data.length;
    if (!isStartSet && start <= position + length) {
      range.setStart(text, start - position);
      isStartSet = true;
    }
    if (isStartSet && end <= position + length) {
      range.setEnd(text, end - position);
      return range;
    }
    position += length;
  }
  return undefined;
};

export const rangeOfComment = (root: Element, comment: Pick<NodeComment, "start" | "end" | "quote">): Range | undefined => {
  const range = rangeAtOffsets(root, comment.start, comment.end);
  return range && withoutSpaces(range.toString()).startsWith(withoutSpaces(comment.quote)) ? range : undefined;
};

export const commentsOfRoll = (node: GraphNode, roll: number): NodeComment[] => (node.comments ?? []).filter((comment) => comment.roll === roll);

const rangesByNode = new Map<string, Range[]>();

const publishRanges = () => {
  const ranges = [...rangesByNode.values()].flat();
  if (ranges.length === 0) registry()?.delete(HIGHLIGHT_NAME);
  else registry()?.set(HIGHLIGHT_NAME, new Highlight(...ranges));
};

const setNodeRanges = (nodeId: string, ranges: Range[]) => {
  if (ranges.length === 0 && !rangesByNode.has(nodeId)) return;
  if (ranges.length === 0) rangesByNode.delete(nodeId);
  else rangesByNode.set(nodeId, ranges);
  publishRanges();
};

export const useCommentHighlights = (node: GraphNode, roll: number, answer: { current: HTMLElement | null }) => {
  useEffect(() => {
    const root = answer.current;
    setNodeRanges(node.id, root ? commentsOfRoll(node, roll).flatMap((comment) => rangeOfComment(root, comment) ?? []) : []);
  });
  useEffect(() => () => setNodeRanges(node.id, []), [node.id]);
};
