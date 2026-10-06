import { useMemo, useState } from "react";
import { describeContext, formatTokens, incomingEdges, isStale, isSummaryUsable, orderedAncestorIds, sameMembers, type GraphNode, type Id } from "@branchboard/core";
import { commitGraphEdit, summariseNode } from "../actions";
import { sendBoardCommand, useBoard } from "../store";

const TURN_LABELS = { context: "Note", code: "Code", file: "File", turn: "Turn", subagent: "Subagent", summary: "Summary" };

const ParentList =({ nodeId }: { nodeId: Id }) => {
  const graph = useBoard((state) => state.view.graph);
  const focusNode = useBoard((state) => state.focusNode);
  const edges = incomingEdges(graph, nodeId);
  const [draggedEdgeId, setDraggedEdgeId] = useState<Id>();
  const dropOn = (targetEdgeId: Id) => {
    if (!draggedEdgeId || draggedEdgeId === targetEdgeId) return;
    const order = edges.map((edge) => edge.id).filter((id) => id !== draggedEdgeId);
    order.splice(order.indexOf(targetEdgeId), 0, draggedEdgeId);
    void commitGraphEdit({ type: "reorderParents", nodeId, edgeIds: order });
    setDraggedEdgeId(undefined);
  };
  if (edges.length === 0) return <div className="muted">No parents. This node starts a fresh context.</div>;
  return (
    <ol className="parent-list">
      {edges.map((edge) => (
        <li key={edge.id} draggable onDragStart={() => setDraggedEdgeId(edge.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropOn(edge.id)}>
          <span className="grip">⋮⋮</span>
          <button className="link" onClick={() => focusNode(edge.fromId)}>{graph.nodes[edge.fromId].title}</button>
          <button className="remove" title="Disconnect" onClick={() => void commitGraphEdit({ type: "disconnect", edgeId: edge.id })}>×</button>
        </li>
      ))}
    </ol>
  );
};

const StalenessDetail = ({ nodeId }: { nodeId: Id }) => {
  const graph = useBoard((state) => state.view.graph);
  const node = graph.nodes[nodeId];
  const current = orderedAncestorIds(graph, nodeId);
  const ranWith = node.contextNodeIds ?? [];
  const titleOf = (id: Id) => graph.nodes[id]?.title ?? "(deleted)";
  const added = current.filter((id) => !ranWith.includes(id));
  const removed = ranWith.filter((id) => !current.includes(id));
  return (
    <div className="stale-detail">
      This answer was made with different context.
      {added.length > 0 && <div>Now also: {added.map(titleOf).join(", ")}</div>}
      {removed.length > 0 && <div>No longer: {removed.map(titleOf).join(", ")}</div>}
      {added.length === 0 && removed.length === 0 && !sameMembers(current, ranWith) && <div>The order or content changed.</div>}
    </div>
  );
};

const SummarySection = ({ node, summarisedCount }: { node: GraphNode; summarisedCount: number }) => {
  const graph = useBoard((state) => state.view.graph);
  const hasSummary = Boolean(node.summary?.text);
  const isUsable = hasSummary && isSummaryUsable(graph, node);
  return (
    <>
      <h4>Summary</h4>
      {summarisedCount > 0 && <div className="muted">{summarisedCount} earlier turn{summarisedCount === 1 ? " is" : "s are"} replaced by a summary on the next run.</div>}
      {hasSummary ? (
        <>
          <div className={`muted ${isUsable ? "" : "summary-old"}`}>{isUsable ? `Covers ${node.summary!.coveredNodeIds.length} turns, about ${node.summary!.tokens} tokens.` : "Out of date: something it covers has changed, so it is not used."}</div>
          <div className="summary-text">{node.summary!.text}</div>
          <div className="summary-actions">
            {node.status === "done" && <button onClick={() => void summariseNode({ node })}>Summarise again</button>}
            <button onClick={() => void sendBoardCommand({ type: "clearSummary", nodeId: node.id })}>Remove</button>
          </div>
        </>
      ) : (
        <>
          <div className="muted">No summary. A summary is a short stand-in for this turn and everything before it.</div>
          {node.status === "done" && <button onClick={() => void summariseNode({ node })}>Summarise up to here</button>}
        </>
      )}
    </>
  );
};

const ContextBody = () => {
  const selectedIds = useBoard((state) => state.selectedIds);
  const graph = useBoard((state) => state.view.graph);
  const parts = useBoard((state) => state.view.parts);
  const catalog = useBoard((state) => state.catalog);
  const focusNode = useBoard((state) => state.focusNode);
  const nodeId = selectedIds.length === 1 ? selectedIds[0] : undefined;
  const node = nodeId ? graph.nodes[nodeId] : undefined;
  const description = useMemo(() => (node && node.kind === "turn" ? describeContext(graph, parts, node.id) : undefined), [graph, parts, node]);
  if (!node) return <div className="muted">Select a node to see what it knows.</div>;
  if (node.kind !== "turn") return <div><h3>{node.title}</h3><div className="muted">A {node.kind === "file" ? "file node" : node.kind === "code" ? "code node" : "note"} feeds the nodes it is connected to.</div></div>;
  const windowSize = node.usage?.contextWindow ?? catalog?.models.find((candidate) => candidate.id === node.model)?.contextWindow;
  return (
    <div>
      <h3>Context of “{node.title}”</h3>
      {isStale(graph, node) && <StalenessDetail nodeId={node.id} />}
      <div className="meter-row">
        <span className={`badge fidelity-${description!.mode}`}>{description!.mode}</span>
        <span>{description!.isApproximate ? "~" : ""}{description!.tokens} tokens{windowSize ? ` of ${windowSize}` : ""}</span>
      </div>
      {windowSize && <progress max={windowSize} value={description!.tokens} />}
      <div className="muted" title="Context the session does not carry; sent again as text">
        Re-sent on next run: ~{formatTokens(description!.republished)} tokens
      </div>
      <SummarySection node={node} summarisedCount={description!.summarisedNodeIds.length} />
      <h4>Parents, in order</h4>
      <ParentList nodeId={node.id} />
      <h4>Turns it will receive</h4>
      {description!.turns.length === 0 && <div className="muted">Nothing yet.</div>}
      <ol className="turn-list">
        {description!.turns.map((turn) => (
          <li key={turn.nodeId}>
            <button className="link" onClick={() => focusNode(turn.nodeId)}>{TURN_LABELS[turn.kind]}: {turn.title}</button>
            <div className="turn-excerpt">{(turn.output || turn.input || turn.attachments.map((item) => item.name).join(", ")).slice(0, 140)}</div>
          </li>
        ))}
      </ol>
    </div>
  );
};

export const ContextPanel = () => (
  <aside className="context-panel">
    <div className="context-body"><ContextBody /></div>
  </aside>
);
