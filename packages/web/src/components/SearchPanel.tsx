import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { liveNodes } from "@branchboard/core";
import { clearCurrentHighlight, restoreOpenedDetails, revealHit, useSearchHighlights } from "../searchHighlight";
import { hitsOfNode, hitsOfNodes, MAX_HITS, type SearchHit } from "../searchHits";
import { useBoard } from "../store";
import { Icon } from "../kit/Icons";

type SearchOrder = "latest" | "oldest";

const SORT_ORDERS: { id: SearchOrder; label: string }[] = [
  { id: "latest", label: "Latest" },
  { id: "oldest", label: "Oldest" },
];

const FOCUS_SETTLE_MS = 450;

const KIND_LABELS = { turn: "Chat", context: "Note", code: "Code", file: "File", subagent: "Subagent" };
const FIELD_LABELS = { title: "Title", prompt: "Prompt", answer: "Answer", tool: "Tool" };

const fieldLabelOf = (hit: SearchHit): string => (hit.field === "tool" && hit.toolName ? `Tool · ${hit.toolName}` : FIELD_LABELS[hit.field]);

export const SearchPanel = () => {
  const graph = useBoard((state) => state.view.graph);
  const parts = useBoard((state) => state.view.parts);
  const focusNode = useBoard((state) => state.focusNode);
  const selectedIds = useBoard((state) => state.selectedIds);
  const selectedNode = selectedIds.length === 1 ? graph.nodes[selectedIds[0]] : undefined;
  const [isThisNodeOnly, setIsThisNodeOnly] = useState(false);
  const scopeNode = isThisNodeOnly ? selectedNode : undefined;
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const needle = query.trim().toLowerCase();
  const [order, setOrder] = useState<SearchOrder>("latest");
  const hits = useMemo(() => {
    if (!needle) return [];
    if (scopeNode) return hitsOfNode(scopeNode, parts[scopeNode.id], needle);
    const sorted = liveNodes(graph).sort((left, right) => (order === "latest" ? right.createdAt - left.createdAt : left.createdAt - right.createdAt));
    return hitsOfNodes(sorted, parts, needle);
  }, [graph, parts, needle, scopeNode, order]);
  const [current, setCurrent] = useState(-1);
  const [refreshTick, setRefreshTick] = useState(0);
  const revealToken = useRef(0);
  useSearchHighlights(query, `${hits.length}:${refreshTick}`, scopeNode?.id);
  useEffect(() => {
    revealToken.current++;
    setCurrent(-1);
    clearCurrentHighlight();
    restoreOpenedDetails();
  }, [needle, scopeNode?.id, order]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(".is-current");
    const scroller = list.current?.closest<HTMLElement>(".context-body");
    if (!row || !scroller) return;
    const rowBox = row.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    if (rowBox.top < scrollerBox.top) scroller.scrollTop += rowBox.top - scrollerBox.top;
    else if (rowBox.bottom > scrollerBox.bottom) scroller.scrollTop += rowBox.bottom - scrollerBox.bottom;
  }, [current]);
  const select = async (index: number) => {
    const hit = hits[index];
    if (!hit) return;
    const token = ++revealToken.current;
    setCurrent(index);
    if (!scopeNode) focusNode(hit.nodeId);
    try {
      await revealHit(hit, needle, scopeNode ? 0 : FOCUS_SETTLE_MS);
    } finally {
      if (token === revealToken.current) setRefreshTick((tick) => tick + 1);
    }
  };
  const step = (direction: 1 | -1) => hits.length > 0 && select((current + direction + hits.length) % hits.length);
  return (
    <div className="search-panel">
      <label className="search-field">
        <Icon name="search" />
        <input
          ref={input}
          value={query}
          placeholder="Search"
          aria-label="Search"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && step(event.shiftKey ? -1 : 1)}
        />
      </label>
      <label className={`search-scope${selectedNode ? "" : " is-disabled"}`} title={selectedNode ? undefined : "Select one node to search inside it"}>
        <input type="checkbox" checked={isThisNodeOnly && Boolean(selectedNode)} disabled={!selectedNode} onChange={(event) => setIsThisNodeOnly(event.target.checked)} />
        <span>This node only</span>
      </label>
      {!scopeNode && (
        <div className="search-sort">
          <span>Sort by</span>
          <div className="ctx-tabs">
            {SORT_ORDERS.map(({ id, label }) => <button key={id} aria-pressed={order === id} className={order === id ? "is-active" : ""} onClick={() => setOrder(id)}>{label}</button>)}
          </div>
        </div>
      )}
      {needle && (
        <div className="search-status">
          <span>{hits.length === 0 ? "No matches" : `${current + 1 || "–"} of ${hits.length >= MAX_HITS ? `${MAX_HITS}+` : hits.length}`}</span>
          {hits.length > 0 && <span>Enter: next · Shift+Enter: previous</span>}
        </div>
      )}
      <div className="search-results" ref={list}>
        {hits.map((hit, index) => {
          const node = graph.nodes[hit.nodeId];
          const startsNode = hits[index - 1]?.nodeId !== hit.nodeId;
          return (
            <Fragment key={`${hit.nodeId}:${index}`}>
              {startsNode && !scopeNode && (
                <div className="search-node">
                  <span className={`ctx-dot kind-${node.kind}`} title={KIND_LABELS[node.kind]} />
                  <strong>{node.title}</strong>
                  <span className="search-kind">{KIND_LABELS[node.kind]}</span>
                </div>
              )}
              <button className={`search-hit${index === current ? " is-current" : ""}`} onClick={() => void select(index)}>
                <span className="search-field-label">{fieldLabelOf(hit)}</span>
                <span className="search-snippet">{hit.before}<mark>{hit.match}</mark>{hit.after}</span>
              </button>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
};
