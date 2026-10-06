import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Handle, Position, useConnection, useStore as useFlowStore, type Node, type NodeProps } from "@xyflow/react";
import { activeRollOf, cacheReadShareOf, childIdsOf, describeToolGroup, edgesAtSide, isOnFlowAxis, isOutputSide, SIDES, usedSidesOf, type Side, groupToolRuns, toolGroupStatus, fileEditOf, fileEditsOf, formatCost, formatDuration, formatTokens, isChosen, isInFlight, isStale, isSummaryUsable, NODE_MAX_HEIGHT, NODE_MAX_WIDTH, preferredPermissionMode, UNSET_CHOICE, lockedNodeIds, minSizeOf, partsOfRoll, rollNumbersOf, satelliteIdsOf, todoProgress, toolFilePathOf, toolInputView, isRepeatedToolName, type GraphNode, type Part, type TodoItem } from "@branchboard/core";
import { availableNodeActions, commitGraphEdit, createAndFocus } from "../actions";
import { attachToNode, droppedFiles, hasFiles } from "../attachments";
import { useAutosavedText } from "../autosave";
import { clearGuides, snapResize } from "../dragSnap";
import { SEEN_DWELL_MS, useIsUnseenResult, usePageVisible, useSeenResults } from "../seenResults";
import { useGraphWithLiveMoves } from "../liveMoves";
import { useSettings } from "../settings";
import { tintStyleOf } from "../tint";
import { sendBoardCommand, useBoard } from "../store";
import { AttachButton, AttachmentList, FileGallery } from "./AttachmentList";
import { ChipSelect } from "./ChipSelect";
import { CodeBody, ExtractFileButton } from "./CodeNode";
import { DiffStat, DiffView, FileEditsSummary } from "./FileEdits";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { ComposerPicker, insertPick, triggerAt, usePickerItems, type PickerItem } from "./ComposerPicker";
import { Icon, IconRow } from "./Icons";
import { Markdown } from "./Markdown";
import { NodeRequests } from "./NodeRequests";
import { PromptBlock } from "./PromptBlock";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { Selectable } from "./Selectable";

const STATUS_LABELS: Record<GraphNode["status"], string> = {
  idle: "Ready",
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Needs your answer",
  done: "Done",
  error: "Error",
  interrupted: "Interrupted",
};

const LOW_DETAIL_ZOOM = 0.4;
const LOW_DETAIL_FONT_SCREEN_PX = 15;
const LOW_DETAIL_FILL = 0.45;
const LOW_DETAIL_CHAR_ASPECT = 0.6;

const SETTLED_STATUSES: GraphNode["status"][] = ["done", "error", "interrupted"];

const EMPTY_PARTS: Part[] = [];

const FRESH_NODE_MS = 3000;
const UNSEEN_GLOW_MAX_SCALE = 14;

const ToolCard = ({ part }: { part: Part }) => {
  const edit = fileEditOf(part.meta?.tool, part.meta?.input);
  const filePath = toolFilePathOf(part.meta?.input);
  const inputView = edit ? undefined : toolInputView(part.meta?.input);
  const toolName = String(part.meta?.tool);
  const summaryText = isRepeatedToolName(part.text, toolName) ? (inputView?.summary ?? "") : part.text;
  return (
    <details className={`tool-card tool-${String(part.meta?.status)}`}>
      <summary>
        <span className="tool-name">{toolName}</span>
        <span className="tool-text">{summaryText}</span>
        {edit && <DiffStat change={edit} isPill />}
        {filePath && <ExtractFileButton path={filePath} />}
        <span className="tool-status">{String(part.meta?.status)}</span>
      </summary>
      {edit && <DiffView rows={edit.rows} />}
      {inputView && <pre className="copyable nodrag tool-primary">{inputView.primaryText}</pre>}
      {inputView?.remaining && <pre className="copyable nodrag">{JSON.stringify(inputView.remaining, null, 2)}</pre>}
      {!edit && !inputView && part.meta?.input !== undefined && <pre className="copyable nodrag">{JSON.stringify(part.meta.input, null, 2)}</pre>}
      {part.meta?.output !== undefined && <pre className="copyable nodrag">{String(part.meta.output)}</pre>}
    </details>
  );
};

const TODO_ICONS = { completed: "todoDone", in_progress: "todoActive", pending: "todoOpen" } as const;

const TodoList = ({ part }: { part: Part }) => {
  const items = (part.meta?.items ?? []) as TodoItem[];
  const { done, total } = todoProgress(items);
  return (
    <div className="todo-list">
      <div className="todo-head">Todos <span className="muted">{done}/{total}</span></div>
      <ul>
        {items.map((item, index) => (
          <li key={index} className={`todo-${item.status}`}>
            <Icon name={TODO_ICONS[item.status]} />
            <span>{item.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const ToolGroup = ({ parts }: { parts: Part[] }) => {
  const status = toolGroupStatus(parts);
  return (
    <details className={`tool-group tool-${status}`}>
      <summary>
        <span className="tool-text">{describeToolGroup(parts)}</span>
        <span className="tool-status">{status}</span>
      </summary>
      <div className="tool-group-body">{parts.map((part) => <ToolCard key={part.id} part={part} />)}</div>
    </details>
  );
};

const PartView = ({ part, isFinished, isLast }: { part: Part; isFinished: boolean; isLast: boolean }) => {
  if (part.type === "todo") return <TodoList part={part} />;
  if (part.type === "tool") return <ToolCard part={part} />;
  if (part.type === "error") return <div className="part-error"><Selectable>{part.text}</Selectable></div>;
  if (part.type === "reasoning" && part.text.trim() === "") return isFinished || !isLast ? null : <div className="thinking-note">Thinking…</div>;
  if (part.type === "reasoning") return <details className="reasoning"><summary>Reasoning</summary><div><Selectable>{part.text}</Selectable></div></details>;
  return <Markdown text={part.text} isStreaming={!isFinished} />;
};

const EFFORT_LABELS: Record<string, string> = { default: "Default effort", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

const Composer = ({ node }: { node: GraphNode }) => {
  const catalog = useBoard((state) => state.catalog);
  const { text: prompt, change: setPrompt, flush: saveDraft, discard: discardDraft } = useAutosavedText(node.prompt, (saved) => void sendBoardCommand({ type: "editNode", nodeId: node.id, fields: { prompt: saved } }));
  const [agent, setAgent] = useState(node.agent ?? "");
  const [model, setModel] = useState(node.model ?? "");
  const [effort, setEffort] = useState(node.effort ?? UNSET_CHOICE);
  const [permissionMode, setPermissionMode] = useState(node.permissionMode);
  const choose = <T extends string>(key: "agent" | "model" | "effort" | "permissionMode", apply: (value: T) => void) => (value: T) => {
    apply(value);
    void sendBoardCommand({ type: "editNode", nodeId: node.id, fields: { [key]: value } });
  };
  const editor = useRef<PromptEditorHandle>(null);
  const [caret, setCaret] = useState(0);
  const [pickerIndex, setPickerIndex] = useState(0);
  const trigger = useMemo(() => triggerAt(prompt, caret), [prompt, caret]);
  const pickerItems = usePickerItems(trigger);
  useEffect(() => setPickerIndex(0), [trigger?.kind, trigger?.query]);
  const pick = (item: PickerItem) => {
    if (!trigger) return;
    const inserted = insertPick(prompt, caret, trigger, item);
    editor.current?.replace(inserted.text, inserted.caret);
  };
  const handlePickerKey = (event: KeyboardEvent): boolean => {
    if (pickerItems.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") setPickerIndex((index) => (index + (event.key === "ArrowDown" ? 1 : pickerItems.length - 1)) % pickerItems.length);
    else if ((event.key === "Enter" && !event.ctrlKey && !event.metaKey) || event.key === "Tab") pick(pickerItems[pickerIndex]);
    else if (event.key === "Escape") setCaret(0);
    else return false;
    event.preventDefault();
    return true;
  };
  const efforts = catalog?.models.find((candidate) => candidate.id === model)?.efforts ?? [];
  const permissionModes = catalog?.permissionModes ?? [];
  const chosenEffort = efforts.includes(effort) ? effort : UNSET_CHOICE;
  const preferredMode = preferredPermissionMode(permissionModes, useSettings((state) => state.settings.defaultPermissionMode));
  const chosenMode = permissionModes.some((mode) => mode.id === permissionMode) ? permissionMode : (preferredMode ?? catalog?.defaultPermissionMode);
  const run = () => {
    discardDraft();
    return sendBoardCommand({ type: "run", nodeId: node.id, prompt, agent: agent || undefined, model: model || undefined, effort: chosenEffort, permissionMode: chosenMode });
  };
  const handleEnterToRun = (event: KeyboardEvent): boolean => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return false;
    event.preventDefault();
    if (prompt.trim()) void run();
    return true;
  };
  return (
    <div className="composer nodrag nowheel">
      <ComposerPicker items={pickerItems} activeIndex={pickerIndex} onPick={pick} />
      <PromptEditor
        ref={editor}
        className="composer-editor"
        autoFocus={Date.now() - node.createdAt < FRESH_NODE_MS}
        value={prompt}
        placeholder="Ask something… (Shift+Enter for a new line, / for commands, @ for files and agents)"
        onChange={setPrompt}
        onCaret={setCaret}
        onBlur={saveDraft}
        onKeyDown={(event) => handlePickerKey(event) || handleEnterToRun(event)}
      />
      <AttachmentList node={node} isEditable />
      <div className="composer-row">
        <div className="composer-chips">
          <AttachButton node={node} />
          {permissionModes.length > 0 && chosenMode && (
            <ChipSelect icon="permission" title="Permission mode" value={chosenMode} options={permissionModes.map((mode) => ({ value: mode.id, label: mode.name }))} onChange={choose("permissionMode", setPermissionMode)} />
          )}
          {(catalog?.agents.length ?? 0) > 1 && (
            <ChipSelect icon="branch" title="Agent" value={agent} options={(catalog?.agents ?? []).map((name) => ({ value: name, label: name }))} onChange={choose("agent", setAgent)} />
          )}
        </div>
        <div className="composer-send">
          <ChipSelect
            icon="model"
            title="Model"
            value={model}
            options={(catalog?.models ?? []).map((candidate) => ({ value: candidate.id, label: candidate.name, group: catalog?.models.some((other) => other.provider !== candidate.provider) ? candidate.provider : undefined }))}
            onChange={choose("model", setModel)}
          />
          {efforts.length > 0 && (
            <ChipSelect icon="effort" title="Effort" value={chosenEffort} options={efforts.map((name) => ({ value: name, label: EFFORT_LABELS[name] ?? name }))} onChange={choose("effort", setEffort)} />
          )}
          <button className="send-button primary" disabled={!prompt.trim()} onClick={run} title="Send (Enter)" aria-label="Send"><Icon name="send" /></button>
        </div>
      </div>
    </div>
  );
};

const NoteBody = ({ node }: { node: GraphNode }) => {
  const { text, change, flush } = useAutosavedText(node.prompt, (saved) => void sendBoardCommand({ type: "editNode", nodeId: node.id, fields: { prompt: saved } }));
  return (
    <PromptEditor className="note-text" value={text} placeholder="Write a note. It feeds every node it is connected to." onChange={change} onBlur={flush} />
  );
};

const FileBody = ({ node }: { node: GraphNode }) => (
  <div className="file-body">
    <FileGallery node={node} />
    <div className="file-footer">
      <AttachButton node={node} label="Add files" />
      <span className="muted">Feeds every node it is connected to</span>
    </div>
  </div>
);

const NodeBody = ({ node, parts, isViewingEarlier }: { node: GraphNode; parts: Part[]; isViewingEarlier: boolean }) => {
  if (node.kind === "context") return <NoteBody node={node} />;
  if (node.kind === "file") return <FileBody node={node} />;
  if (node.kind === "code") return <CodeBody node={node} />;
  if (node.kind === "subagent") return <ChatBody node={node} parts={parts} isViewingEarlier={isViewingEarlier} />;
  return node.status === "idle" ? <Composer node={node} /> : <ChatBody node={node} parts={parts} isViewingEarlier={isViewingEarlier} />;
};

const FOLLOW_TOLERANCE_PX = 24;

const useFollowScroll = (isStreaming: boolean, version: unknown) => {
  const element = useRef<HTMLDivElement>(null);
  const isFollowing = useRef(true);
  const isEnabled = useSettings((state) => state.settings.followScroll);
  const trackUserScroll = () => {
    const target = element.current;
    if (target) isFollowing.current = target.scrollHeight - target.scrollTop - target.clientHeight <= FOLLOW_TOLERANCE_PX;
  };
  useEffect(() => {
    if (!isStreaming) isFollowing.current = true;
  }, [isStreaming]);
  useLayoutEffect(() => {
    const target = element.current;
    if (isEnabled && isStreaming && isFollowing.current && target) target.scrollTop = target.scrollHeight;
  }, [isEnabled, isStreaming, version]);
  return { element, trackUserScroll };
};

const SubagentInline = ({ satellite }: { satellite: GraphNode }) => {
  const allParts = useBoard((state) => state.view.parts[satellite.id]) ?? EMPTY_PARTS;
  const parts = useMemo(() => partsOfRoll(allParts, activeRollOf(satellite)), [allParts, satellite]);
  const isFinished = SETTLED_STATUSES.includes(satellite.status);
  return (
    <details className="subagent-inline" open={!isFinished}>
      <summary>
        <IconRow names={["subagent"]} />
        <span>{satellite.title}</span>
        <span className={`badge status-${satellite.status}`}>{STATUS_LABELS[satellite.status]}</span>
        <Elapsed node={satellite} />
      </summary>
      <div className="subagent-inline-body nowheel">
        <NodeRequests nodeId={satellite.id} />
        {parts.map((part, index) => <PartView key={part.id} part={part} isFinished={isFinished} isLast={index === parts.length - 1} />)}
      </div>
    </details>
  );
};

const useInlineSubagents = (node: GraphNode): GraphNode[] => {
  const graph = useBoard((state) => state.view.graph);
  const isInline = useSettings((state) => state.settings.subagentDisplay) === "inline";
  return useMemo(() => (isInline && node.kind === "turn" ? satelliteIdsOf(graph, node.id).map((id) => graph.nodes[id]) : []), [isInline, graph, node.id, node.kind]);
};

const ChatBody = ({ node, parts, isViewingEarlier }: { node: GraphNode; parts: Part[]; isViewingEarlier: boolean }) => {
  const isFinished = SETTLED_STATUSES.includes(node.status) || isViewingEarlier;
  const { element, trackUserScroll } = useFollowScroll(isInFlight(node), parts);
  const inlineSubagents = useInlineSubagents(node);
  const fileEdits = useMemo(() => fileEditsOf(parts), [parts]);
  const isGrouping = useSettings((state) => state.settings.groupToolCalls);
  const runs = useMemo(() => groupToolRuns(parts), [parts]);
  useLayoutEffect(() => {
    if (isFinished && element.current) element.current.scrollTop = element.current.scrollHeight;
  }, []);
  return (
    <>
      {node.quoteText && <div className="quote-chip"><Selectable>Regarding: {node.quoteText}</Selectable></div>}
      <PromptBlock node={node} />
      <NodeRequests nodeId={node.id} />
      <div className="answer nowheel" ref={element} onScroll={trackUserScroll}>
        {isGrouping
          ? runs.map((run, index) => (run.kind === "tools" ? <ToolGroup key={run.parts[0].id} parts={run.parts} /> : <PartView key={run.part.id} part={run.part} isFinished={isFinished} isLast={index === runs.length - 1} />))
          : parts.map((part, index) => <PartView key={part.id} part={part} isFinished={isFinished} isLast={index === parts.length - 1} />)}
        {inlineSubagents.map((satellite) => <SubagentInline key={satellite.id} satellite={satellite} />)}
        {isFinished && <FileEditsSummary edits={fileEdits} />}
        {node.stopped && <div className="stopped-note">stopped</div>}
      </div>
    </>
  );
};

const TitleLabel = ({ node }: { node: GraphNode }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(node.title);
  const commit = () => {
    setIsEditing(false);
    if (title.trim() && title !== node.title) void sendBoardCommand({ type: "editNode", nodeId: node.id, fields: { title: title.trim() } });
  };
  if (!isEditing) return <div className="node-label" onDoubleClick={() => (setTitle(node.title), setIsEditing(true))}>{node.title}</div>;
  return <input className="node-label-input nodrag" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commit} onKeyDown={(event) => event.key === "Enter" && commit()} />;
};

const LIVE_STATUSES: GraphNode["status"][] = ["running", "awaiting_approval"];
export const ELAPSED_TICK_MS = 200;

const cacheBadgeTitle = (usage: GraphNode["usage"]): string => {
  const firstCall = usage?.firstCallCacheCreationTokens === undefined ? "" : `. First call: ${formatTokens(usage.firstCallCacheReadTokens ?? 0)} read, ${formatTokens(usage.firstCallCacheCreationTokens)} written`;
  return `Share of input tokens read from the prompt cache. Total: ${formatTokens(usage?.cacheReadTokens ?? 0)} read, ${formatTokens(usage?.cacheCreationTokens ?? 0)} written${firstCall}`;
};

const Elapsed = ({ node }: { node: GraphNode }) => {
  const isLive = LIVE_STATUSES.includes(node.status);
  const [currentTime, setCurrentTime] = useState(Date.now());
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => setCurrentTime(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [isLive]);
  const finishedAt = isLive ? currentTime : node.completedAt;
  if (node.startedAt === undefined || finishedAt === undefined || !(isLive || SETTLED_STATUSES.includes(node.status))) return null;
  return <span className="badge elapsed">{formatDuration(Math.max(0, finishedAt - node.startedAt))}</span>;
};

interface RollSwitcherProps {
  node: GraphNode;
  isViewOnly: boolean;
  shownRoll: number;
  onView: (roll: number | undefined) => void;
}

const RollSwitcher = ({ node, isViewOnly, shownRoll, onView }: RollSwitcherProps) => {
  const rolls = rollNumbersOf(node);
  if (node.kind !== "turn" || rolls.length < 2) return null;
  const position = rolls.indexOf(shownRoll);
  const select = (offset: number) => {
    const roll = rolls[position + offset];
    if (isViewOnly) onView(roll === activeRollOf(node) ? undefined : roll);
    else void sendBoardCommand({ type: "selectRoll", nodeId: node.id, roll });
  };
  const title = isViewOnly ? "Browsing earlier answers (view only while running)" : "Regenerated answers; only the shown one feeds child nodes";
  return (
    <div className="card-footer">
      <span className="roll-switcher nodrag" title={title}>
        <button disabled={position <= 0} onClick={() => select(-1)} aria-label="Previous roll">‹</button>
        <span>{position + 1}/{rolls.length}</span>
        <button disabled={position >= rolls.length - 1} onClick={() => select(1)} aria-label="Next roll">›</button>
      </span>
    </div>
  );
};

const Badges = ({ node, stale, isBlocked, summaryState }: { node: GraphNode; stale: boolean; isBlocked: boolean; summaryState: "none" | "fresh" | "stale" }) => (
  <div className="badges">
    {node.kind === "subagent" && <span className="badge"><IconRow names={["subagent"]} />Subagent</span>}
    {node.kind === "subagent" && node.agent && <span className="badge" title="Agent">{node.agent}</span>}
    <span className={`badge status-${node.status}`}>{STATUS_LABELS[node.status]}</span>
    {summaryState !== "none" && <span className={`badge ${summaryState === "stale" ? "stale" : ""}`} title={summaryState === "fresh" ? "Summary stored; used when context is re-sent" : "Summary is out of date and ignored"}>summary{summaryState === "stale" ? " (old)" : ""}</span>}
    <Elapsed node={node} />
    {isBlocked && <span className="badge blocked" title="A child node is running. Stop it to edit this one"><IconRow names={["lock"]} />Locked</span>}
    {node.forceAssemble && <span className="badge fidelity-assembled" title="The whole context will be re-sent as text">assemble</span>}
    {node.kind === "turn" && node.model && <span className="badge">{node.model}</span>}
    {node.kind === "turn" && node.agent && <span className="badge">{node.agent}</span>}
    {node.kind === "turn" && isChosen(node.effort) && <span className="badge" title="Effort">{node.effort}</span>}
    {node.kind === "turn" && isChosen(node.permissionMode) && <span className="badge" title="Permission mode">{node.permissionMode}</span>}
    {node.contextMode && <span className={`badge fidelity-${node.contextMode}`}>{node.contextMode}</span>}
    {stale && <span className="badge stale">context changed</span>}
    {node.usage && <span className="badge">{node.usage.inputTokens + node.usage.outputTokens} tok</span>}
    {node.usage?.costUsd !== undefined && <span className="badge" title="Cost reported by the runtime for this run">{formatCost(node.usage.costUsd)}</span>}
    {node.usage?.contextTokens !== undefined && node.usage.contextWindow && (
      <span className="badge" title="Context window used by the last model call">ctx {formatTokens(node.usage.contextTokens)}/{formatTokens(node.usage.contextWindow)} ({Math.round((node.usage.contextTokens / node.usage.contextWindow) * 100)}%)</span>
    )}
    {cacheReadShareOf(node.usage) !== undefined && (
      <span className="badge" title={cacheBadgeTitle(node.usage)}>cache {Math.round(cacheReadShareOf(node.usage)! * 100)}%</span>
    )}
  </div>
);

const NodeActions = ({ node }: { node: GraphNode }) => {
  const graphVersion = useBoard((state) => state.view.graph);
  const available = useMemo(
    () =>
      availableNodeActions(node).map((action) => {
        const hint = action.hint?.({ node });
        return { action, title: hint ? `${action.label({ node })}: ${hint}` : action.label({ node }) };
      }),
    [node, graphVersion],
  );
  return (
    <div className="node-actions">
      {available.map(({ action, title }) => (
        <button key={action.id} className={action.isActive?.({ node }) ? "active" : ""} aria-pressed={action.isActive ? action.isActive({ node }) : undefined} title={title} aria-label={action.label({ node })} onClick={() => void action.run({ node })}>
          <IconRow names={action.icons({ node })} />
        </button>
      ))}
    </div>
  );
};

const NextPrompt = ({ node }: { node: GraphNode }) => {
  const snapBelow = useSettings((state) => state.settings.snapNextPrompt);
  return (
    <button className="next-prompt" onClick={() => void createAndFocus({ type: "reply", parentIds: [node.id], snapBelow })}>
      Next prompt…
    </button>
  );
};

interface ResizeAxes {
  horizontal: boolean;
  vertical: boolean;
}

const RESIZE_HANDLES: { className: string; title: string; axes: ResizeAxes }[] = [
  { className: "is-right", title: "Drag to change the width", axes: { horizontal: true, vertical: false } },
  { className: "is-bottom", title: "Drag to change the height", axes: { horizontal: false, vertical: true } },
  { className: "is-corner", title: "Drag to resize", axes: { horizontal: true, vertical: true } },
];

const useCornerResize = (node: GraphNode) => {
  const zoom = useFlowStore((state) => state.transform[2]);
  const [dragSize, setDragSize] = useState<{ w: number; h: number }>();
  useEffect(() => setDragSize(undefined), [node.w, node.h]);
  const beginResize = (event: ReactPointerEvent, axes: ResizeAxes) => {
    event.stopPropagation();
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY, w: node.w, h: node.h };
    let latest = { w: node.w, h: node.h };
    const move = (moveEvent: PointerEvent) => {
      const clampSize = (size: { w: number; h: number }) => ({
        w: axes.horizontal ? Math.round(Math.min(NODE_MAX_WIDTH, Math.max(minSizeOf(node.kind).w, size.w))) : node.w,
        h: axes.vertical ? Math.round(Math.min(NODE_MAX_HEIGHT, Math.max(minSizeOf(node.kind).h, size.h))) : node.h,
      });
      const raw = clampSize({ w: origin.w + (moveEvent.clientX - origin.x) / zoom, h: origin.h + (moveEvent.clientY - origin.y) / zoom });
      if (moveEvent.altKey) latest = clampSize(snapResize(node, raw, axes, zoom));
      else {
        clearGuides();
        latest = raw;
      }
      setDragSize(latest);
    };
    const finish = () => {
      clearGuides();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      void sendBoardCommand({ type: "moveNodes", positions: { [node.id]: latest } });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };
  return { size: dragSize ?? { w: node.w, h: node.h }, beginResize };
};

const SIDE_POSITIONS: Record<Side, Position> = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };

const MENU_TITLE_CHARS = 40;

const shortTitle = (title: string): string => (title.length > MENU_TITLE_CHARS ? `${title.slice(0, MENU_TITLE_CHARS)}…` : title);

const FlowHandles = ({ node }: { node: GraphNode }) => {
  const graph = useGraphWithLiveMoves();
  const direction = useSettings((state) => state.settings.flowDirection);
  const isConnecting = useConnection().inProgress;
  const usedSides = useMemo(() => usedSidesOf(graph, node.id, direction), [graph, node.id, direction]);
  const { open, element } = useContextMenu();
  const isSatellite = node.kind === "subagent";
  const disconnectMenuAt = (side: Side) => (event: ReactMouseEvent) => {
    const connected = edgesAtSide(graph, node.id, side, direction);
    const items: MenuItem[] = connected.map(({ edgeId, otherNodeId }) => ({ label: `Disconnect “${shortTitle(graph.nodes[otherNodeId]?.title ?? "node")}”`, run: () => void commitGraphEdit({ type: "disconnect", edgeId }) }));
    if (items.length > 1) items.push({ label: `Disconnect all ${items.length}`, run: () => connected.forEach(({ edgeId }) => void commitGraphEdit({ type: "disconnect", edgeId })) });
    if (items.length === 0) event.preventDefault();
    else open(items)(event);
  };
  return (
    <>
      {SIDES.map((side) => {
        const isShown = isConnecting || isOnFlowAxis(side, direction) || usedSides.has(side);
        const className = `flow-handle side-${side} ${isShown ? "" : "is-hidden"}`;
        const isOutput = isOutputSide(side);
        return (
          <Fragment key={side}>
            {(node.kind === "turn" || node.kind === "code" || isSatellite) && (
              <Handle type="target" id={`${side}-target`} position={SIDE_POSITIONS[side]} isConnectable={!isSatellite} className={`${className} ${isOutput || isSatellite ? "is-passive" : ""}`} onContextMenu={disconnectMenuAt(side)} />
            )}
            {!isSatellite && <Handle type="source" id={`${side}-source`} position={SIDE_POSITIONS[side]} className={`${className} ${isOutput ? "" : "is-passive"}`} onContextMenu={disconnectMenuAt(side)} />}
          </Fragment>
        );
      })}
      {element}
    </>
  );
};

type BranchNode = Node<{ nodeId: string }, "bb">;

const NodeShellComponent = ({ data, selected }: NodeProps<BranchNode>) => {
  const node = useBoard((state) => state.view.graph.nodes[data.nodeId]);
  const allParts = useBoard((state) => state.view.parts[data.nodeId]) ?? EMPTY_PARTS;
  const graphForLocks = useBoard((state) => state.view.graph);
  const [viewedRoll, setViewedRoll] = useState<number>();
  const isViewOnly = node ? isInFlight(node) || lockedNodeIds(graphForLocks).has(node.id) : false;
  useEffect(() => {
    if (!isViewOnly) setViewedRoll(undefined);
  }, [isViewOnly]);
  const shownRoll = node ? (isViewOnly ? viewedRoll : undefined) ?? activeRollOf(node) : 0;
  const parts = useMemo(() => (node ? partsOfRoll(allParts, shownRoll) : EMPTY_PARTS), [allParts, shownRoll, node === undefined]);
  const graph = useBoard((state) => state.view.graph);
  const zoom = useFlowStore((state) => state.transform[2]);
  const isLowDetail = zoom < LOW_DETAIL_ZOOM;
  const stale = useMemo(() => (node ? isStale(graph, node) : false), [graph, node]);
  const hiddenCount = useMemo(() => (node?.collapsed ? childIdsOf(graph, node.id).length : 0), [graph, node]);
  const { size, beginResize } = useCornerResize(node ?? ({ id: data.nodeId, w: 0, h: 0 } as GraphNode));
  const [isDropTarget, setIsDropTarget] = useState(false);
  const blinksForAttention = useSettings((state) => state.settings.blinkForAttention);
  const isOnlySelected = useBoard((state) => state.selectedIds.length <= 1);
  const isUnseen = useIsUnseenResult(data.nodeId);
  const isPageVisible = usePageVisible();
  useEffect(() => {
    if (!isUnseen || isLowDetail || !isPageVisible || node?.completedAt === undefined) return;
    const { completedAt } = node;
    const timer = setTimeout(() => useSeenResults.getState().markSeen(data.nodeId, completedAt), SEEN_DWELL_MS);
    return () => clearTimeout(timer);
  }, [isUnseen, isLowDetail, isPageVisible, data.nodeId, node?.completedAt]);
  if (!node) return null;
  const isBlocked = !isInFlight(node) && lockedNodeIds(graph).has(node.id);
  const summaryState = !node.summary?.text ? "none" : isSummaryUsable(graph, node) ? "fresh" : "stale";
  const acceptDrop = (event: ReactDragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDropTarget(event.type === "dragover");
    if (event.type === "drop") void attachToNode(node.id, droppedFiles(event));
  };
  return (
    <div className={`node-wrapper ${selected ? "selected" : ""} ${isDropTarget ? "drop-target" : ""}`} onDragOver={acceptDrop} onDragLeave={() => setIsDropTarget(false)} onDrop={acceptDrop}>
      <div className={`node-card kind-${node.kind} status-${node.status} ${isLowDetail ? "is-low-detail" : ""} ${isLowDetail && blinksForAttention && node.status === "awaiting_approval" ? "is-attention-blink" : ""} ${stale ? "is-stale" : ""} ${isBlocked ? "is-blocked" : ""} ${isUnseen ? "is-unseen" : ""}`} style={{ width: Math.max(size.w, minSizeOf(node.kind).w), height: Math.max(size.h, minSizeOf(node.kind).h), ...tintStyleOf(node.title), ...(isUnseen || node.status === "running" || node.status === "queued" ? ({ "--glow": Math.min(UNSEEN_GLOW_MAX_SCALE, Math.max(1, 1 / zoom)) } as CSSProperties) : {}) }}>
        <FlowHandles node={node} />
        <div className="node-head">
          <TitleLabel node={node} />
          {node.pinned && <span className="pin-mark" title="Pinned: it cannot be moved or resized"><Icon name="pin" /></span>}
        </div>
        {(node.kind === "turn" || node.kind === "subagent") && <Badges node={node} stale={stale} isBlocked={isBlocked} summaryState={summaryState} />}
        {isLowDetail && <div className="lod-title" style={{ fontSize: Math.min(LOW_DETAIL_FONT_SCREEN_PX / zoom, Math.sqrt((node.w * node.h * LOW_DETAIL_FILL) / (Math.max(node.title.length, 1) * LOW_DETAIL_CHAR_ASPECT))) }}>{node.title}</div>}
        {!isLowDetail && <NodeBody node={node} parts={parts} isViewingEarlier={shownRoll !== activeRollOf(node)} />}
        {!isLowDetail && <RollSwitcher node={node} isViewOnly={isViewOnly} shownRoll={shownRoll} onView={setViewedRoll} />}
        {hiddenCount > 0 && <div className="collapsed-note">{hiddenCount} collapsed</div>}
        {!node.pinned && RESIZE_HANDLES.map(({ className, title, axes }) => <div key={className} className={`resize-handle ${className} nodrag nopan`} onPointerDown={(event) => beginResize(event, axes)} title={title}><span /></div>)}
      </div>
      {selected && isOnlySelected && !isLowDetail && (
        <div className="node-below nodrag">
          {node.kind === "turn" && SETTLED_STATUSES.includes(node.status) && <NextPrompt node={node} />}
          <NodeActions node={node} />
        </div>
      )}
    </div>
  );
};

export const NodeShell = memo(NodeShellComponent);
