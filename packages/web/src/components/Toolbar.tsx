import { useEffect, useMemo, useRef, useState } from "react";
import { activeRollOf, answerText, liveNodes } from "@branchboard/core";
import { actionById, titleWithShortcut } from "../actions";
import { useSearchHighlights } from "../searchHighlight";
import { useSettings } from "../settings";
import { useBoard } from "../store";
import { IconRow } from "../kit/Icons";

const MAX_RESULTS = 8;
const HIGHLIGHT_REFRESH_MS = 700;

const KIND_LABELS = { turn: "Chat", context: "Note", code: "Code", file: "File", subagent: "Subagent" };

const SearchBox = () => {
  const graph = useBoard((state) => state.view.graph);
  const parts = useBoard((state) => state.view.parts);
  const focusNode = useBoard((state) => state.focusNode);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.(".toolbar")) useBoard.getState().setSearchOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && useBoard.getState().setSearchOpen(false);
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return liveNodes(graph).filter((node) => [node.title, node.prompt, answerText(parts[node.id], activeRollOf(node))].some((text) => text.toLowerCase().includes(needle)));
  }, [graph, parts, query]);
  const results = matches.slice(0, MAX_RESULTS);
  const [current, setCurrent] = useState(-1);
  const [refreshTick, setRefreshTick] = useState(0);
  useSearchHighlights(query, `${matches.length}:${refreshTick}`);
  useEffect(() => setCurrent(-1), [query]);
  const close = () => useBoard.getState().setSearchOpen(false);
  const step = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (current + direction + matches.length) % matches.length;
    setCurrent(next);
    focusNode(matches[next].id);
    setTimeout(() => setRefreshTick((tick) => tick + 1), HIGHLIGHT_REFRESH_MS);
  };
  return (
    <div className="search-box">
      <input
        ref={input}
        value={query}
        placeholder="Search inside nodes"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
          if (event.key === "Enter") step(event.shiftKey ? -1 : 1);
        }}
      />
      {query.trim() && <span className="muted">{matches.length === 0 ? "No matches" : `${current + 1 || "–"} of ${matches.length} nodes (Enter: next, Shift+Enter: previous)`}</span>}
      {results.map((node) => (
        <button key={node.id} className="link" onClick={() => (focusNode(node.id), close())}>{KIND_LABELS[node.kind]}: {node.title}</button>
      ))}
    </div>
  );
};

export const Toolbar = () => {
  const isSearchOpen = useBoard((state) => state.isSearchOpen);
  const keybinds = useSettings((state) => state.settings.keybinds);
  return (
    <div className="toolbar">
      {isSearchOpen && <SearchBox />}
      {["newChat", "newNote", "newCode", "newFile", "search"].map((id) => {
        const action = actionById(id);
        return <button key={id} onClick={() => void action.run({})} title={titleWithShortcut(id, keybinds)} aria-label={action.label({})}><IconRow names={action.icons({})} /></button>;
      })}
    </div>
  );
};
