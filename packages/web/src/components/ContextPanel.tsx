import { useMemo, useState, type ReactNode } from "react";
import { describeContext, formatAgo, formatTokens, incomingEdges, isStale, isSummaryUsable, orderedAncestorIds, sameMembers, type ContextMode, type GraphNode, type Id } from "@branchboard/core";
import { commitGraphEdit, summariseNode } from "../actions";
import { useSettings } from "../settings";
import { sendBoardCommand, useBoard } from "../store";
import { Icon } from "../kit/Icons";

const KIND_LABELS = { context: "Note", code: "Code", file: "File", turn: "Chat", subagent: "Subagent", summary: "Summary" };

const MODE_LABELS: Record<ContextMode, { label: string; hint: string }> = {
  exact: { label: "Session", hint: "The parent's session already holds all of this context." },
  injected: { label: "Session + text", hint: "The parent's session is continued and the turns it lacks are added as text." },
  assembled: { label: "Text", hint: "The whole context is sent as text." },
};

const WARNING_SHARE = 0.8;
const EXCERPT_LENGTH = 160;

const KindDot = ({ kind }: { kind: keyof typeof KIND_LABELS }) => <span className={`ctx-dot kind-${kind}`} title={KIND_LABELS[kind]} />;

const Section = ({ title, count, children }: { title: string; count?: number; children: ReactNode }) => (
  <details className="ctx-section" open>
    <summary>
      <Icon name="chevronRight" />
      <span>{title}</span>
      {count !== undefined && <span className="ctx-count">{count}</span>}
    </summary>
    <div className="ctx-section-body">{children}</div>
  </details>
);

const ParentList = ({ nodeId }: { nodeId: Id }) => {
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
  if (edges.length === 0) return <div className="ctx-empty">No parents. This node starts a new context.</div>;
  return (
    <ol className="ctx-list">
      {edges.map((edge) => (
        <li key={edge.id} className={`ctx-row${draggedEdgeId === edge.id ? " is-dragged" : ""}`} draggable onDragStart={() => setDraggedEdgeId(edge.id)} onDragEnd={() => setDraggedEdgeId(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropOn(edge.id)}>
          <span className="ctx-grip" title="Drag to change the order"><Icon name="dragHandle" /></span>
          <KindDot kind={graph.nodes[edge.fromId].kind} />
          <button className="ctx-link" onClick={() => focusNode(edge.fromId)}>{graph.nodes[edge.fromId].title}</button>
          <button className="ctx-remove" title="Disconnect this parent" aria-label="Disconnect this parent" onClick={() => void commitGraphEdit({ type: "disconnect", edgeId: edge.id })}><Icon name="close" /></button>
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
    <div className="ctx-notice">
      <strong>Answer is out of date</strong>
      <span>It was made with different context. Regenerate it to use the current one.</span>
      {added.length > 0 && <span>Added since: {added.map(titleOf).join(", ")}</span>}
      {removed.length > 0 && <span>Removed since: {removed.map(titleOf).join(", ")}</span>}
      {added.length === 0 && removed.length === 0 && !sameMembers(current, ranWith) && <span>The order or content changed.</span>}
    </div>
  );
};

const SummaryBody = ({ node, summarisedCount }: { node: GraphNode; summarisedCount: number }) => {
  const graph = useBoard((state) => state.view.graph);
  const hasSummary = Boolean(node.summary?.text);
  const isUsable = hasSummary && isSummaryUsable(graph, node);
  const summarisable = [node, ...incomingEdges(graph, node.id).map((edge) => graph.nodes[edge.fromId])].filter((candidate) => candidate?.kind === "turn" && candidate.status === "done");
  return (
    <>
      {summarisedCount > 0 && <div className="ctx-note">{summarisedCount} earlier turn{summarisedCount === 1 ? " is" : "s are"} replaced by this summary on the next run.</div>}
      {hasSummary ? (
        <>
          <div className={`ctx-note${isUsable ? "" : " is-warning"}`}>{isUsable ? `Covers ${node.summary!.coveredNodeIds.length} turns, about ${node.summary!.tokens} tokens.` : "Out of date: something it covers has changed, so it is not used."}</div>
          <div className="ctx-summary-text">{node.summary!.text}</div>
          <div className="ctx-actions">
            {node.status === "done" && <button onClick={() => void summariseNode({ node })}>Summarise again</button>}
            <button onClick={() => void sendBoardCommand({ type: "clearSummary", nodeId: node.id })}>Remove</button>
          </div>
        </>
      ) : (
        <>
          <div className="ctx-note">A summary replaces a finished turn and everything before it with a shorter text.</div>
          <div className="ctx-actions">
            {summarisable.map((target) => <button key={target.id} onClick={() => void summariseNode({ node: target })}>Summarise up to {target.id === node.id ? "here" : target.title}</button>)}
          </div>
        </>
      )}
    </>
  );
};

const UsageCard = ({ tokens, isApproximate, windowSize, republished, mode }: { tokens: number; isApproximate: boolean; windowSize?: number; republished: number; mode: ContextMode }) => {
  const share = windowSize ? Math.min(1, tokens / windowSize) : 0;
  return (
    <div className="ctx-usage">
      <div className="ctx-usage-top">
        <span className="ctx-tokens">{isApproximate ? "~" : ""}{formatTokens(tokens)}<small> tokens</small></span>
        <span className="ctx-mode" title={MODE_LABELS[mode].hint}>{MODE_LABELS[mode].label}</span>
      </div>
      {windowSize && (
        <>
          <div className="ctx-bar" role="progressbar" aria-valuemin={0} aria-valuemax={windowSize} aria-valuenow={tokens}>
            <span className={share >= WARNING_SHARE ? "is-warning" : ""} style={{ width: `${Math.max(share * 100, 1)}%` }} />
          </div>
          <div className="ctx-usage-foot">{Math.round(share * 100)}% of the {formatTokens(windowSize)} window</div>
        </>
      )}
      <div className="ctx-usage-foot" title="Context the session does not hold is sent again as text">{republished > 0 ? `${formatTokens(republished)} tokens are sent again on the next run` : "Nothing is sent again on the next run"}</div>
    </div>
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
  if (selectedIds.length > 1) return <div className="ctx-placeholder">Select one node to see its context.</div>;
  if (!node) return <div className="ctx-placeholder">Select a node to see what it receives from the nodes above it.</div>;
  if (node.kind !== "turn") {
    return (
      <>
        <div className="ctx-heading"><KindDot kind={node.kind} /><strong>{node.title}</strong></div>
        <div className="ctx-note">A {node.kind === "file" ? "file node" : node.kind === "code" ? "code node" : "note"} adds its content to the context of every node it is connected to.</div>
      </>
    );
  }
  const windowSize = node.usage?.contextWindow ?? catalog?.models.find((candidate) => candidate.id === node.model)?.contextWindow;
  const resentIds = new Set(description!.plan.missingTurns.map((turn) => turn.nodeId));
  return (
    <>
      <div className="ctx-heading"><KindDot kind="turn" /><strong>{node.title}</strong></div>
      {isStale(graph, node) && <StalenessDetail nodeId={node.id} />}
      <UsageCard tokens={description!.tokens} isApproximate={description!.isApproximate} windowSize={windowSize} republished={description!.republished} mode={description!.mode} />
      {node.compactedAt && <div className="ctx-note">The saved session was compacted {formatAgo(Date.now() - node.compactedAt)} ago. The runtime replaced earlier turns in it with a summary.</div>}
      <Section title="Parents" count={incomingEdges(graph, node.id).length}>
        <ParentList nodeId={node.id} />
      </Section>
      <Section title="Context sent" count={description!.turns.length}>
        {description!.turns.length === 0 && <div className="ctx-empty">Nothing yet.</div>}
        <ol className="ctx-list">
          {description!.turns.map((turn) => (
            <li key={turn.nodeId} className="ctx-turn">
              <div className="ctx-turn-head">
                <KindDot kind={turn.kind} />
                <button className="ctx-link" onClick={() => focusNode(turn.nodeId)}>{turn.title}</button>
                <span className={`ctx-delivery${resentIds.has(turn.nodeId) ? " is-text" : ""}`}>{resentIds.has(turn.nodeId) ? "Text" : "Session"}</span>
              </div>
              <div className="ctx-excerpt">{(turn.output || turn.input || turn.attachments.map((item) => item.name).join(", ")).slice(0, EXCERPT_LENGTH)}</div>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Summary">
        <SummaryBody node={node} summarisedCount={description!.summarisedNodeIds.length} />
      </Section>
    </>
  );
};

export const ContextPanel = () => {
  const updateSetting = useSettings((state) => state.update);
  return (
    <aside data-tour="context-panel" className="context-panel">
      <header className="ctx-header">
        <strong>Context</strong>
        <button className="icon-button" onClick={() => updateSetting("isContextPanelOpen", false)} title="Hide the context panel" aria-label="Hide the context panel"><Icon name="close" /></button>
      </header>
      <div className="context-body"><ContextBody /></div>
    </aside>
  );
};
