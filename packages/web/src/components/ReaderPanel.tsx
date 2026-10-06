import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { activeRollOf, describeContext, formatTokens, partsOfRoll, type GraphNode, type Part, type Turn, type TurnKind } from "@branchboard/core";
import { useEdgeResize } from "../panelResize";
import { READER_DEFAULT_WIDTH, READER_MAX_WIDTH, READER_MIN_WIDTH, useSettings } from "../settings";
import { useBoard } from "../store";
import { Icon } from "./Icons";
import { Markdown } from "./Markdown";

const EMPTY_PARTS: Part[] = [];

const COPIED_FEEDBACK_MS = 1500;

const KIND_LABELS: Record<TurnKind, string> = { turn: "", context: "Note", code: "Code", summary: "Summary", file: "Files", subagent: "Subagent" };

const AttachmentNames = ({ names }: { names: string[] }) =>
  names.length === 0 ? null : (
    <div className="reader-files">
      {names.map((name) => <span key={name} className="reader-file"><Icon name="paperclip" />{name}</span>)}
    </div>
  );

const TurnHeader = ({ nodeId, title, label }: { nodeId?: string; title: string; label?: string }) => {
  const focusNode = useBoard((state) => state.focusNode);
  return (
    <header className="reader-turn-head">
      {label && <span className="reader-kind">{label}</span>}
      {nodeId ? <button className="reader-title" onClick={() => focusNode(nodeId)} title="Show this node on the board">{title}</button> : <span className="reader-title">{title}</span>}
    </header>
  );
};

const TurnBlock = ({ turn }: { turn: Turn }) => (
  <article className={`reader-turn kind-${turn.kind}`}>
    <TurnHeader nodeId={turn.nodeId} title={turn.title} label={KIND_LABELS[turn.kind]} />
    {turn.kind === "turn" && turn.input && <div className="reader-prompt">{turn.input}</div>}
    {turn.kind !== "turn" && turn.input && <div className="reader-answer"><Markdown text={turn.kind === "code" ? `\`\`\`\n${turn.input}\n\`\`\`` : turn.input} /></div>}
    <AttachmentNames names={turn.attachments.map((item) => item.name)} />
    {turn.kind === "turn" && turn.output && <div className="reader-answer"><Markdown text={turn.output} /></div>}
  </article>
);

const SummaryBlock = ({ turn, covered }: { turn: Turn; covered: Turn[] }) => (
  <article className="reader-turn kind-summary">
    <TurnHeader title={`Summary of ${covered.length} earlier turn${covered.length === 1 ? "" : "s"}`} label="Summary" />
    <div className="reader-answer"><Markdown text={turn.input} /></div>
    <details className="reader-originals">
      <summary>Show the original turns</summary>
      <div className="reader-originals-body">{covered.map((original) => <TurnBlock key={original.nodeId} turn={original} />)}</div>
    </details>
  </article>
);

const OwnTurn = ({ node, parts }: { node: GraphNode; parts: Part[] }) => {
  const isFinished = ["done", "error", "interrupted"].includes(node.status);
  const answer = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  const errors = parts.filter((part) => part.type === "error");
  return (
    <article className="reader-turn reader-own">
      <TurnHeader title={node.title} label="Selected" />
      <div className="reader-prompt">{node.prompt || <span className="muted">No prompt yet</span>}</div>
      <AttachmentNames names={(node.attachments ?? []).map((item) => item.name)} />
      {answer && <div className="reader-answer"><Markdown text={answer} isStreaming={!isFinished} /></div>}
      {errors.map((part) => <div key={part.id} className="part-error">{part.text}</div>)}
      {!answer && errors.length === 0 && node.status !== "idle" && <div className="muted">{node.status === "done" ? "No answer text" : "Working…"}</div>}
    </article>
  );
};

const transcriptOf = (turns: Turn[], node: GraphNode, answer: string): string => {
  const earlier = turns.map((turn) => [`## ${turn.title}`, turn.input && `${turn.kind === "turn" ? "**Prompt**\n\n" : ""}${turn.input}`, turn.kind === "turn" && turn.output && `**Answer**\n\n${turn.output}`].filter(Boolean).join("\n\n"));
  const own = [`## ${node.title}`, node.prompt && `**Prompt**\n\n${node.prompt}`, answer && `**Answer**\n\n${answer}`].filter(Boolean).join("\n\n");
  return [...earlier, own].join("\n\n---\n\n");
};

const CopyTranscript = ({ text }: { text: string }) => {
  const [isCopied, setIsCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), COPIED_FEEDBACK_MS);
    }).catch(() => undefined);
  };
  return <button className="icon-button" onClick={copy} title="Copy the conversation as Markdown" aria-label="Copy the conversation as Markdown"><Icon name={isCopied ? "check" : "copy"} /></button>;
};

const ReaderEmpty = () => (
  <div className="reader-empty">
    <Icon name="reader" />
    <strong>Nothing to read yet</strong>
    <span>Select a chat node to read the conversation that leads to it, in order.</span>
  </div>
);

const ReaderContent = () => {
  const selectedIds = useBoard((state) => state.selectedIds);
  const graph = useBoard((state) => state.view.graph);
  const allParts = useBoard((state) => state.view.parts);
  const node = selectedIds.length === 1 ? graph.nodes[selectedIds[0]] : undefined;
  const description = useMemo(() => (node?.kind === "turn" ? describeContext(graph, allParts, node.id) : undefined), [graph, allParts, node]);
  const scroller = useRef<HTMLDivElement>(null);
  const own = useRef<HTMLDivElement>(null);
  const nodeId = node?.id;
  useLayoutEffect(() => {
    if (nodeId && own.current && scroller.current) scroller.current.scrollTop = own.current.offsetTop - 12;
  }, [nodeId]);
  if (!node || node.kind !== "turn" || !description) return <div className="reader-scroll"><ReaderEmpty /></div>;
  const summaryTurn = description.plan.missingTurns.find((turn) => turn.kind === "summary");
  const coveredIds = new Set(summaryTurn?.coveredNodeIds ?? []);
  const covered = description.turns.filter((turn) => coveredIds.has(turn.nodeId));
  const remaining = description.turns.filter((turn) => !coveredIds.has(turn.nodeId));
  const parts = partsOfRoll(allParts[node.id] ?? EMPTY_PARTS, activeRollOf(node));
  const answer = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  return (
    <>
      <div className="reader-summary-bar">
        <div className="reader-summary-text">
          <strong title={node.title}>{node.title}</strong>
          <span>{description.turns.length + 1} turn{description.turns.length === 0 ? "" : "s"} · ~{formatTokens(description.tokens)} tokens of context</span>
        </div>
        <CopyTranscript text={transcriptOf(description.turns, node, answer)} />
      </div>
      <div className="reader-scroll" ref={scroller}>
        <div className="reader-flow">
          {summaryTurn && <SummaryBlock turn={summaryTurn} covered={covered} />}
          {remaining.map((turn) => <TurnBlock key={turn.nodeId} turn={turn} />)}
          <div ref={own}><OwnTurn node={node} parts={parts} /></div>
        </div>
      </div>
    </>
  );
};

export const ReaderPanel = () => {
  const storedWidth = useSettings((state) => state.settings.readerWidth);
  const updateSetting = useSettings((state) => state.update);
  const { width, isResizing, beginResize, resetWidth } = useEdgeResize(storedWidth, READER_MIN_WIDTH, READER_MAX_WIDTH, (next) => updateSetting("readerWidth", next));
  return (
    <aside className={`reader-panel ${isResizing ? "is-resizing" : ""}`} style={{ width }}>
      <div className="panel-resize-edge" onPointerDown={beginResize} onDoubleClick={() => resetWidth(READER_DEFAULT_WIDTH)} role="separator" aria-orientation="vertical" aria-label="Drag to resize the reader (double-click to reset)" title="Drag to resize. Double-click to reset" />
      <header className="reader-header">
        <strong><Icon name="reader" /> Reader</strong>
        <button className="icon-button" onClick={() => useBoard.getState().setReaderOpen(false)} aria-label="Close the reader" title="Close the reader"><Icon name="close" /></button>
      </header>
      <ReaderContent />
    </aside>
  );
};
