import { useEffect, useMemo, useRef, useState } from "react";
import { activeRollOf, answerText, liveNodes } from "@branchboard/core";
import { actionById, titleWithShortcut } from "../actions";
import { useSettings } from "../settings";
import { useBoard } from "../store";
import { IconRow } from "./Icons";

const MAX_RESULTS = 8;

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
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return liveNodes(graph)
      .filter((node) => [node.title, node.prompt, answerText(parts[node.id], activeRollOf(node))].some((text) => text.toLowerCase().includes(needle)))
      .slice(0, MAX_RESULTS);
  }, [graph, parts, query]);
  const close = () => useBoard.getState().setSearchOpen(false);
  return (
    <div className="search-box">
      <input ref={input} value={query} placeholder="Search titles, prompts and answers" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Escape" && close()} />
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
