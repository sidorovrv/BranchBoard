import { useEffect } from "react";
import type { SearchHit } from "./searchHits";

const HIGHLIGHT_NAME = "node-search";
const CURRENT_HIGHLIGHT_NAME = "node-search-current";
const NODE_SELECTOR = ".react-flow__node";
const TOOL_SELECTOR = "details.tool-card, details.tool-group";
const MAX_RANGES = 2000;
const HIGHLIGHT_DELAY_MS = 120;
const NODE_WAIT_MS = 1500;
const POLL_MS = 40;
const BODY_RENDER_MS = 120;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

declare const Highlight: new (...ranges: Range[]) => unknown;

const registry = (): HighlightRegistry | undefined => (CSS as unknown as { highlights?: HighlightRegistry }).highlights;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const nodeElementOf = (nodeId: string): Element | undefined => [...document.querySelectorAll(NODE_SELECTOR)].find((element) => element.getAttribute("data-id") === nodeId);

const rangesIn = (root: Element, needle: string, limit = MAX_RANGES): Range[] => {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text && ranges.length < limit; text = walker.nextNode()) {
    const content = text.textContent?.toLowerCase() ?? "";
    for (let at = content.indexOf(needle); at >= 0; at = content.indexOf(needle, at + needle.length)) {
      const range = new Range();
      range.setStart(text, at);
      range.setEnd(text, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
};

const rangesOfQuery = (needle: string, nodeId?: string): Range[] => {
  const roots = nodeId ? [nodeElementOf(nodeId)].filter((element): element is Element => element !== undefined) : [...document.querySelectorAll(NODE_SELECTOR)];
  return roots.flatMap((root) => rangesIn(root, needle));
};

const isScrollable = (element: HTMLElement): boolean => {
  const overflow = getComputedStyle(element).overflowY;
  return (overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight;
};

const revealRange = (range: Range) => {
  const target = range.getBoundingClientRect();
  for (let element = range.startContainer.parentElement; element && !element.matches(NODE_SELECTOR); element = element.parentElement) {
    if (!isScrollable(element)) continue;
    const box = element.getBoundingClientRect();
    element.scrollTop += target.top - box.top - box.height / 2;
  }
};

const flatten = (text: string): string => text.replace(/\s+/g, " ").toLowerCase();

const contextVariantsOf = (hit: SearchHit): string[] => {
  const before = flatten(hit.before.replace(/^…/, ""));
  const match = flatten(hit.match);
  const after = flatten(hit.after.replace(/…$/, ""));
  return [before + match + after, before + match, match + after, match];
};

const pickRange = (ranges: Range[], hit: SearchHit): Range | undefined => {
  for (const variant of contextVariantsOf(hit)) {
    const candidates = ranges.filter((range) => flatten(range.startContainer.textContent ?? "").includes(variant));
    if (candidates.length > 0) return candidates[Math.min(hit.duplicate, candidates.length - 1)];
  }
  return ranges[Math.min(hit.nodeOccurrence, ranges.length - 1)];
};

let openedBySearch: HTMLDetailsElement[] = [];

export const restoreOpenedDetails = () => {
  openedBySearch.forEach((details) => (details.open = false));
  openedBySearch = [];
};

const openWithAncestors = (details: HTMLDetailsElement, nodeElement: Element) => {
  for (let element: Element | null = details; element && element !== nodeElement; element = element.parentElement) {
    if (element instanceof HTMLDetailsElement && !element.open) {
      element.open = true;
      openedBySearch.push(element);
    }
  }
};

const waitForNode = async (nodeId: string): Promise<Element | undefined> => {
  for (let waited = 0; waited < NODE_WAIT_MS; waited += POLL_MS) {
    const element = nodeElementOf(nodeId);
    if (element) return element;
    await wait(POLL_MS);
  }
  return undefined;
};

const revealInToolCard = async (hit: SearchHit, needle: string, nodeElement: Element): Promise<Range | undefined> => {
  const cards = [...nodeElement.querySelectorAll<HTMLDetailsElement>("details.tool-card")];
  const preferred = hit.toolOrdinal === undefined ? undefined : cards[hit.toolOrdinal];
  for (const card of [preferred, ...cards.filter((candidate) => candidate !== preferred)]) {
    if (!card) continue;
    const alreadyOpened = openedBySearch.length;
    openWithAncestors(card, nodeElement);
    await wait(BODY_RENDER_MS);
    const range = pickRange(rangesIn(card, needle), hit);
    if (range) return range;
    openedBySearch.splice(alreadyOpened).forEach((details) => (details.open = false));
  }
  return undefined;
};

const CANVAS_SCROLL_HOSTS = ".app, .workspace, .canvas-area, .react-flow, .react-flow__renderer, .react-flow__pane";

const resetCanvasScroll = () => {
  document.querySelectorAll<HTMLElement>(CANVAS_SCROLL_HOSTS).forEach((host) => {
    host.scrollTop = 0;
    host.scrollLeft = 0;
  });
};

export const revealHit = async (hit: SearchHit, needle: string, settleMs: number): Promise<boolean> => {
  restoreOpenedDetails();
  if (settleMs > 0) await wait(settleMs);
  const nodeElement = await waitForNode(hit.nodeId);
  if (!nodeElement) return false;
  const range =
    hit.field === "tool"
      ? await revealInToolCard(hit, needle, nodeElement)
      : pickRange(rangesIn(nodeElement, needle).filter((candidate) => !candidate.startContainer.parentElement?.closest(TOOL_SELECTOR)), hit);
  if (!range) return false;
  registry()?.set(CURRENT_HIGHLIGHT_NAME, new Highlight(range));
  revealRange(range);
  resetCanvasScroll();
  return true;
};

export const clearCurrentHighlight = () => registry()?.delete(CURRENT_HIGHLIGHT_NAME);

export const useSearchHighlights = (query: string, refreshKey: unknown, scopeNodeId: string | undefined) => {
  useEffect(() => {
    const highlights = registry();
    const needle = query.trim().toLowerCase();
    if (!highlights) return;
    const timer = setTimeout(() => {
      const found = needle ? rangesOfQuery(needle, scopeNodeId) : [];
      if (found.length > 0) highlights.set(HIGHLIGHT_NAME, new Highlight(...found));
      else highlights.delete(HIGHLIGHT_NAME);
    }, HIGHLIGHT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, refreshKey, scopeNodeId]);
  useEffect(
    () => () => {
      registry()?.delete(HIGHLIGHT_NAME);
      clearCurrentHighlight();
      restoreOpenedDetails();
    },
    [],
  );
};
