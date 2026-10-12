import { useEffect } from "react";

const HIGHLIGHT_NAME = "node-search";
const NODE_SELECTOR = ".react-flow__node";
const MAX_RANGES = 2000;
const HIGHLIGHT_DELAY_MS = 120;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

declare const Highlight: new (...ranges: Range[]) => unknown;

const registry = (): HighlightRegistry | undefined => (CSS as unknown as { highlights?: HighlightRegistry }).highlights;

const rangesOfQuery = (needle: string): Range[] => {
  const ranges: Range[] = [];
  for (const node of document.querySelectorAll(NODE_SELECTOR)) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text && ranges.length < MAX_RANGES; text = walker.nextNode()) {
      const content = text.textContent?.toLowerCase() ?? "";
      for (let at = content.indexOf(needle); at >= 0; at = content.indexOf(needle, at + needle.length)) {
        const range = new Range();
        range.setStart(text, at);
        range.setEnd(text, at + needle.length);
        ranges.push(range);
      }
    }
  }
  return ranges;
};

export const useSearchHighlights = (query: string, refreshKey: unknown) => {
  useEffect(() => {
    const highlights = registry();
    const needle = query.trim().toLowerCase();
    if (!highlights) return;
    const timer = setTimeout(() => (needle ? highlights.set(HIGHLIGHT_NAME, new Highlight(...rangesOfQuery(needle))) : highlights.delete(HIGHLIGHT_NAME)), HIGHLIGHT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, refreshKey]);
  useEffect(() => () => registry()?.delete(HIGHLIGHT_NAME), []);
};
