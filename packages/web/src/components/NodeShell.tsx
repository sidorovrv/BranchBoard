import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Handle, Position, useConnection, useStore as useFlowStore, type Node, type NodeProps } from "@xyflow/react";
import { activeRollOf, cacheReadShareOf, childIdsOf, edgesAtSide, isOnFlowAxis, isOutputSide, SIDES, usedSidesOf, type Side, formatCost, formatDuration, formatTokens, isChosen, isInFlight, isStale, isSummaryUsable, NODE_MAX_HEIGHT, NODE_MAX_WIDTH, preferredPermissionMode, UNSET_CHOICE, lockedNodeIds, minSizeOf, partsOfRoll, rollNumbersOf, subagentIdsOf, type GraphNode, type Part } from "@branchboard/core";
import { availableNodeActions, commitGraphEdit, createAndFocus } from "../actions";
import { fetchWorkspaceFiles } from "../api";
import { attachToNode, droppedFiles, hasFiles } from "../attachments";
import { useAutosavedText } from "../autosave";
import { useCommentHighlights } from "../commentAnchors";
import { clearGuides, isGuideHeld, snapResize } from "../dragSnap";
import { SEEN_DWELL_MS, useIsUnseenResult, usePageVisible, useSeenResults } from "../seenResults";
import { useGraphWithLiveMoves, useLiveMoves } from "../liveMoves";
import { useDetachedSubagentIds, useSubagentDetached } from "../detachedSubagents";
import { useSettings, type NodeTagId } from "../settings";
import { tintStyleOf } from "../tint";
import { sendBoardCommand, useBoard } from "../store";
import { cancelScheduledSend, formatRunCountdown, scheduleSend, useNow, useScheduledSends } from "../scheduledSends";
import { AttachButton, AttachmentList, FileGallery } from "./AttachmentList";
import { ScheduleRunDialog, SendMenu } from "./ScheduleRun";
import { ChipSelect } from "../kit/ChipSelect";
import { ChatView, PartView } from "../kit/ChatView";
import { Icon, IconRow } from "../kit/Icons";
import { Markdown } from "../kit/Markdown";
import { Selectable } from "../kit/Selectable";
import { CodeBody } from "./CodeNode";
import { NodeLiveControls, NodePrompt, NodeRequests, useNodeRevert } from "./ChatAdapters";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { ComposerFrame } from "../kit/ComposerFrame";
import { ComposerPicker, insertPick, triggerAt, usePickerItems, type PickerItem } from "../kit/ComposerPicker";
import { PromptEditor, type PromptEditorHandle } from "../kit/PromptEditor";
import { RecoveryButton } from "./RecoveryButton";
import { RememberedScroll, useRememberedScroll } from "../nodeScroll";

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
  const boardId = useBoard((state) => state.board?.id);
  const searchFiles = useMemo(() => (boardId ? (query: string) => fetchWorkspaceFiles(boardId, query) : undefined), [boardId]);
  const pickerItems = usePickerItems(trigger, { catalog: catalog && { ...catalog, commands: catalog.commands ?? [] }, searchFiles });
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
  const effortModel = isChosen(model) ? model : catalog?.defaultModel;
  const efforts = catalog?.models.find((candidate) => candidate.id === effortModel)?.efforts ?? [];
  const permissionModes = catalog?.permissionModes ?? [];
  const chosenEffort = efforts.includes(effort) ? effort : UNSET_CHOICE;
  const preferredMode = preferredPermissionMode(permissionModes, useSettings((state) => state.settings.defaultPermissionMode));
  const chosenMode = permissionModes.some((mode) => mode.id === permissionMode) ? permissionMode : (preferredMode ?? catalog?.defaultPermissionMode);
  const run = () => {
    cancelScheduledSend(node.id);
    discardDraft();
    return sendBoardCommand({ type: "run", boardId, nodeId: node.id, prompt, agent: agent || undefined, model: model || undefined, effort: chosenEffort, permissionMode: chosenMode });
  };
  const latestRun = useRef(run);
  latestRun.current = run;
  const scheduledAt = useScheduledSends((state) => state.runAt[node.id]);
  const now = useNow(scheduledAt !== undefined);
  const [openSendPanel, setOpenSendPanel] = useState<"menu" | "schedule">();
  const closeSendPanel = () => setOpenSendPanel(undefined);
  const isSendable = scheduledAt !== undefined || prompt.trim() !== "";
  const schedule = (at: number) => {
    if (boardId) scheduleSend(node.id, at, () => latestRun.current(), { boardId, title: node.title, prompt });
    closeSendPanel();
  };
  const unschedule = () => {
    cancelScheduledSend(node.id);
    closeSendPanel();
  };
  const handleEnterToRun = (event: KeyboardEvent): boolean => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return false;
    event.preventDefault();
    if (prompt.trim()) void run();
    return true;
  };
  return (
    <ComposerFrame
      picker={<ComposerPicker items={pickerItems} activeIndex={pickerIndex} onPick={pick} />}
      editor={
        <RememberedScroll scrollKey={`${node.id}:composer`} selector=".cm-scroller">
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
        </RememberedScroll>
      }
      attachments={<AttachmentList node={node} isEditable />}
      leading={
        <>
          <AttachButton node={node} />
          {permissionModes.length > 0 && chosenMode && (
            <ChipSelect icon="permission" title="Permission mode: what the agent may do unasked" value={chosenMode} options={permissionModes.map((mode) => ({ value: mode.id, label: mode.name }))} onChange={choose("permissionMode", setPermissionMode)} />
          )}
          {(catalog?.agents.length ?? 0) > 1 && (
            <ChipSelect icon="branch" title="Agent" value={agent} options={(catalog?.agents ?? []).map((name) => ({ value: name, label: name }))} onChange={choose("agent", setAgent)} />
          )}
        </>
      }
      trailing={
        <>
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
        </>
      }
      send={
        scheduledAt === undefined
          ? { label: "Send (Enter)", disabled: !isSendable, onClick: () => void run() }
          : { label: "Scheduled run: change time", disabled: !isSendable, countdown: formatRunCountdown(scheduledAt - now), onClick: () => setOpenSendPanel("schedule") }
      }
      sendOptions={{ label: "More send options", disabled: !isSendable, onClick: () => setOpenSendPanel(openSendPanel === "menu" ? undefined : "menu") }}
      overlay={
        <>
          {openSendPanel === "menu" && <SendMenu onSchedule={() => setOpenSendPanel("schedule")} onClose={closeSendPanel} />}
          {openSendPanel === "schedule" && <ScheduleRunDialog scheduledAt={scheduledAt} onSchedule={schedule} onUnschedule={unschedule} onClose={closeSendPanel} />}
        </>
      }
    />
  );
};

const NoteBody = ({ node }: { node: GraphNode }) => {
  const { text, change, flush } = useAutosavedText(node.prompt, (saved) => void sendBoardCommand({ type: "editNode", nodeId: node.id, fields: { prompt: saved } }));
  return (
    <RememberedScroll scrollKey={`${node.id}:note`} selector=".cm-scroller">
      <PromptEditor className="note-text" value={text} placeholder="Write a note. It feeds every node it is connected to." onChange={change} onBlur={flush} />
    </RememberedScroll>
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

const NodeBody = ({ node, parts, roll }: { node: GraphNode; parts: Part[]; roll: number }) => {
  if (node.kind === "context") return <NoteBody node={node} />;
  if (node.kind === "file") return <FileBody node={node} />;
  if (node.kind === "code") return <CodeBody node={node} />;
  if (node.kind === "subagent") return <ChatBody node={node} parts={parts} roll={roll} />;
  return node.status === "idle" ? <Composer node={node} /> : <ChatBody node={node} parts={parts} roll={roll} />;
};

const SubagentToolCard = ({ part, satellite }: { part: Part; satellite: GraphNode }) => {
  const allParts = useBoard((state) => state.view.parts[satellite.id]) ?? EMPTY_PARTS;
  const parts = useMemo(() => partsOfRoll(allParts, activeRollOf(satellite)), [allParts, satellite]);
  const isFinished = SETTLED_STATUSES.includes(satellite.status);
  const [isDetached, setDetached] = useSubagentDetached(satellite.id);
  const focusNode = useBoard((state) => state.focusNode);
  const toggleDetached = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDetached(!isDetached);
    if (!isDetached) focusNode(satellite.id);
  };
  return (
    <details className={`tool-card tool-${satellite.status}`} open={!isFinished}>
      <summary>
        <span className="tool-name">{String(part.meta?.tool)}</span>
        <span className="tool-text">{part.text}</span>
        <button type="button" className="extract-file" aria-pressed={isDetached} title={isDetached ? "Hide the separate node" : "Open as a separate node"} aria-label={isDetached ? "Hide the separate node" : "Open as a separate node"} onClick={toggleDetached}>
          <Icon name="subagent" />
        </button>
        <span className="tool-status">{STATUS_LABELS[satellite.status]} <Elapsed node={satellite} /></span>
      </summary>
      <div className="subagent-inline-body">
        {parts.map((inner, index) => <PartView key={inner.id} part={inner} isFinished={isFinished} isLast={index === parts.length - 1} />)}
      </div>
    </details>
  );
};

const useRenderSubagentPart = () => {
  const nodes = useBoard((state) => state.view.graph.nodes);
  const isInline = useSettings((state) => state.settings.subagentDisplay) === "inline";
  return (part: Part) => {
    const satellites = isInline ? subagentIdsOf(part).map((id) => nodes[id]).filter((satellite) => satellite && !satellite.deleted) : [];
    return satellites.length > 0 ? satellites.map((satellite) => <SubagentToolCard key={satellite.id} part={part} satellite={satellite} />) : undefined;
  };
};

const useRequestNodeIds = (node: GraphNode, parts: Part[]): string[] => {
  const isInline = useSettings((state) => state.settings.subagentDisplay) === "inline";
  const detachedIds = useDetachedSubagentIds();
  const inlineIds = isInline ? parts.flatMap(subagentIdsOf).filter((id) => !detachedIds.includes(id)) : [];
  return [node.id, ...inlineIds];
};

const ChatBody = ({ node, parts, roll }: { node: GraphNode; parts: Part[]; roll: number }) => {
  const isFinished = SETTLED_STATUSES.includes(node.status) || roll !== activeRollOf(node);
  const answer = useRef<HTMLDivElement>(null);
  const renderSubagentPart = useRenderSubagentPart();
  const requestNodeIds = useRequestNodeIds(node, parts);
  const isGrouping = useSettings((state) => state.settings.groupToolCalls);
  const isFollowing = useSettings((state) => state.settings.followScroll);
  const revert = useNodeRevert(node);
  useCommentHighlights(node, roll, answer);
  useRememberedScroll(answer, `${node.id}:answer`);
  return (
    <ChatView
      parts={parts}
      isFinished={isFinished}
      isStreaming={isInFlight(node)}
      isGrouping={isGrouping}
      isFollowing={isFollowing}
      roll={roll}
      answerRef={answer}
      revert={revert}
      isStopped={node.stopped}
      renderRecovery={(part) => <RecoveryButton node={node} part={part as Part} />}
      header={
        <>
          {node.quoteText && <div className="quote-chip"><Selectable>Regarding: {node.quoteText}</Selectable></div>}
          <NodePrompt node={node} />
          <NodeRequests nodeIds={requestNodeIds} />
        </>
      }
      renderPart={renderSubagentPart}
      footer={<NodeLiveControls node={node} />}
    />
  );
};

const TitleLabel = ({ node }: { node: GraphNode }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(node.title);
  const commit = () => {
    setIsEditing(false);
    if (title.trim() && title.trim() !== node.title) void sendBoardCommand({ type: "editNode", nodeId: node.id, fields: { title: title.trim() } });
  };
  if (!isEditing) return <div className="node-label" onDoubleClick={() => (setTitle(node.title), setIsEditing(true))}>{node.title}</div>;
  return <input className="node-label-input nodrag" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commit} onKeyDown={(event) => (event.key === "Enter" && commit()) || (event.key === "Escape" && (setTitle(node.title), setIsEditing(false)))} />;
};

const LIVE_STATUSES: GraphNode["status"][] = ["running", "awaiting_approval"];
export const ELAPSED_TICK_MS = 200;

const cacheBadgeTitle = (usage: GraphNode["usage"]): string => {
  const firstCall = usage?.firstCallCacheCreationTokens === undefined ? "" : `. First call: ${formatTokens(usage.firstCallCacheReadTokens ?? 0)} read, ${formatTokens(usage.firstCallCacheCreationTokens)} written`;
  return `Prompt cache: share of input tokens read from the prompt cache. Total: ${formatTokens(usage?.cacheReadTokens ?? 0)} read, ${formatTokens(usage?.cacheCreationTokens ?? 0)} written${firstCall}`;
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
  return <span className="badge elapsed" title="Run time">{formatDuration(Math.max(0, finishedAt - node.startedAt))}</span>;
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
      <span data-tour="rolls" className="roll-switcher nodrag" title={title}>
        <button disabled={position <= 0} onClick={() => select(-1)} aria-label="Previous answer">‹</button>
        <span>{position + 1}/{rolls.length}</span>
        <button disabled={position >= rolls.length - 1} onClick={() => select(1)} aria-label="Next answer">›</button>
      </span>
    </div>
  );
};

const LOW_DETAIL_CHIP_MAX_SCALE = 4;

const CommentsChip = ({ node, zoom }: { node: GraphNode; zoom: number }) => {
  const openComments = (node.comments ?? []).filter((comment) => comment.roll === activeRollOf(node)).length;
  if (openComments === 0) return null;
  const isLowDetail = zoom < LOW_DETAIL_ZOOM;
  return (
    <span className={`comments-chip ${isLowDetail ? "is-low-detail" : ""}`} style={isLowDetail ? { transform: `scale(${Math.min(LOW_DETAIL_CHIP_MAX_SCALE, 1 / zoom)})` } : undefined} title="Comments waiting to be sent with the next reply">
      <Icon name="comment" />
      {openComments}
    </span>
  );
};

const Badges = ({ node, stale, isBlocked, summaryState }: { node: GraphNode; stale: boolean; isBlocked: boolean; summaryState: "none" | "fresh" | "stale" }) => {
  const shownTags = useSettings((state) => state.settings.shownTags);
  const shows = (id: NodeTagId) => shownTags.includes(id);
  const isClaudeCostShown = useSettings((state) => state.settings.showClaudeCost);
  const isClaudeBoard = useBoard((state) => state.board?.mode === "claude");
  const showsCost = isClaudeCostShown || !isClaudeBoard;
  const hasTags = node.kind === "subagent" || shownTags.length > 0;
  if (!hasTags) return null;
  return (
    <div className="badges">
      {node.kind === "subagent" && <span className="badge"><IconRow names={["subagent"]} />Subagent</span>}
      {node.kind === "subagent" && node.agent && shows("agent") && <span className="badge" title="Agent">{node.agent}</span>}
      {shows("status") && <span className={`badge status-${node.status}`} title="Status">{STATUS_LABELS[node.status]}</span>}
      {shows("summary") && summaryState !== "none" && <span className={`badge ${summaryState === "stale" ? "stale" : ""}`} title={summaryState === "fresh" ? "Summary stored; used when context is re-sent" : "Summary is out of date and ignored"}>summary{summaryState === "stale" ? " (old)" : ""}</span>}
      {shows("runTime") && <Elapsed node={node} />}
      {shows("locked") && isBlocked && <span className="badge blocked" title="A child node is running. Stop it to edit this one"><IconRow names={["lock"]} />Locked</span>}
      {shows("assemble") && node.forceAssemble && <span className="badge fidelity-assembled" title="The whole context will be re-sent as text">assemble</span>}
      {shows("model") && node.kind === "turn" && node.model && <span className="badge" title="Model">{node.model}</span>}
      {shows("agent") && node.kind === "turn" && node.agent && <span className="badge" title="Agent">{node.agent}</span>}
      {shows("effort") && node.kind === "turn" && isChosen(node.effort) && <span className="badge" title="Effort">{node.effort}</span>}
      {shows("permissionMode") && node.kind === "turn" && isChosen(node.permissionMode) && <span className="badge" title="Permission mode">{node.permissionMode}</span>}
      {shows("contextMode") && node.contextMode && <span className={`badge fidelity-${node.contextMode}`} title={`Context mode: ${node.contextMode}`}>{node.contextMode}</span>}
      {shows("contextChanged") && stale && <span data-tour="stale" className="badge stale" title="Context status: an ancestor changed after this answer">context changed</span>}
      {shows("tokens") && node.usage && <span className="badge" title="Tokens used by this run">{node.usage.inputTokens + node.usage.outputTokens} tok</span>}
      {shows("cost") && showsCost && node.usage?.costUsd !== undefined && <span className="badge" title="Cost: reported by the runtime for this run">{formatCost(node.usage.costUsd)}</span>}
      {shows("contextWindow") && node.usage?.contextTokens !== undefined && node.usage.contextWindow && (
        <span className="badge" title="Context window: used by the last model call">ctx {formatTokens(node.usage.contextTokens)}/{formatTokens(node.usage.contextWindow)} ({Math.round((node.usage.contextTokens / node.usage.contextWindow) * 100)}%)</span>
      )}
      {shows("cache") && cacheReadShareOf(node.usage) !== undefined && (
        <span className="badge" title={cacheBadgeTitle(node.usage)}>cache {Math.round(cacheReadShareOf(node.usage)! * 100)}%</span>
      )}
    </div>
  );
};

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
        <button key={action.id} data-tour={action.id === "reply" ? "branch" : undefined} className={action.isActive?.({ node }) ? "active" : ""} aria-pressed={action.isActive ? action.isActive({ node }) : undefined} title={title} aria-label={action.label({ node })} onClick={() => void action.run({ node })}>
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

type EdgeDirection = -1 | 0 | 1;

interface ResizeDirection {
  x: EdgeDirection;
  y: EdgeDirection;
}

const LIVE_RESIZE_SETTLE_MS = 400;

const RESIZE_HANDLES: { className: string; title: string; direction: ResizeDirection }[] = [
  { className: "is-right", title: "Drag to change the width", direction: { x: 1, y: 0 } },
  { className: "is-left", title: "Drag to change the width", direction: { x: -1, y: 0 } },
  { className: "is-bottom", title: "Drag to change the height", direction: { x: 0, y: 1 } },
  { className: "is-top", title: "Drag to change the height", direction: { x: 0, y: -1 } },
  { className: "is-corner", title: "Drag to resize", direction: { x: 1, y: 1 } },
  { className: "is-corner-bl", title: "Drag to resize", direction: { x: -1, y: 1 } },
  { className: "is-corner-tl", title: "Drag to resize", direction: { x: -1, y: -1 } },
  { className: "is-corner-tr", title: "Drag to resize", direction: { x: 1, y: -1 } },
];

const useCornerResize = (node: GraphNode) => {
  const zoom = useFlowStore((state) => state.transform[2]);
  const [dragSize, setDragSize] = useState<{ w: number; h: number }>();
  useEffect(() => setDragSize(undefined), [node.w, node.h]);
  const beginResize = (event: ReactPointerEvent, direction: ResizeDirection) => {
    event.stopPropagation();
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY, w: node.w, h: node.h };
    const min = minSizeOf(node.kind);
    let latest = { x: node.x, y: node.y, w: node.w, h: node.h };
    const move = (moveEvent: PointerEvent) => {
      const clampSize = (size: { w: number; h: number }) => ({
        w: direction.x !== 0 ? Math.round(Math.min(NODE_MAX_WIDTH, Math.max(min.w, size.w))) : node.w,
        h: direction.y !== 0 ? Math.round(Math.min(NODE_MAX_HEIGHT, Math.max(min.h, size.h))) : node.h,
      });
      const raw = clampSize({
        w: origin.w + (direction.x * (moveEvent.clientX - origin.x)) / zoom,
        h: origin.h + (direction.y * (moveEvent.clientY - origin.y)) / zoom,
      });
      const isGuided = isGuideHeld(moveEvent);
      const size = isGuided ? clampSize(snapResize(node, raw, direction, zoom)) : raw;
      if (!isGuided) clearGuides();
      latest = {
        x: direction.x === -1 ? node.x + node.w - size.w : node.x,
        y: direction.y === -1 ? node.y + node.h - size.h : node.y,
        ...size,
      };
      setDragSize(size);
      useLiveMoves.getState().update({ [node.id]: { x: latest.x, y: latest.y } });
    };
    const finish = () => {
      clearGuides();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      void sendBoardCommand({ type: "moveNodes", positions: { [node.id]: latest } }).finally(() => setTimeout(() => useLiveMoves.getState().clear(), LIVE_RESIZE_SETTLE_MS));
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
              <Handle type="target" id={`${side}-target`} position={SIDE_POSITIONS[side]} isConnectable={!isSatellite} className={`${className} ${isSatellite ? "is-passive" : isOutput ? "is-passive is-hidden" : ""}`} onContextMenu={disconnectMenuAt(side)} />
            )}
            {!isSatellite && <Handle type="source" id={`${side}-source`} position={SIDE_POSITIONS[side]} className={`${className} ${isOutput ? "" : "is-passive is-hidden"}`} onContextMenu={disconnectMenuAt(side)} />}
          </Fragment>
        );
      })}
      {element}
    </>
  );
};

type BranchNode = Node<{ nodeId: string }, "bb">;

const VIEWPORT_MARGIN_SHARE = 0.5;

const useIsNearViewport = (x: number, y: number, w: number, h: number): boolean =>
  useFlowStore((state) => {
    const [panX, panY, zoom] = state.transform;
    const [marginX, marginY] = [state.width * VIEWPORT_MARGIN_SHARE, state.height * VIEWPORT_MARGIN_SHARE];
    const [left, top] = [x * zoom + panX, y * zoom + panY];
    return left + w * zoom > -marginX && left < state.width + marginX && top + h * zoom > -marginY && top < state.height + marginY;
  });

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
  const showsBody = useIsNearViewport(node?.x ?? 0, node?.y ?? 0, size.w, size.h) && !isLowDetail;
  const [isDropTarget, setIsDropTarget] = useState(false);
  const blinksForAttention = useSettings((state) => state.settings.blinkForAttention);
  const isOnlySelected = useBoard((state) => state.selectedIds.length <= 1);
  const isUnseen = useIsUnseenResult(data.nodeId);
  const isPageVisible = usePageVisible();
  useEffect(() => {
    if (!isUnseen || isLowDetail || !isPageVisible || node?.completedAt === undefined) return;
    const { completedAt } = node;
    const timer = setTimeout(() => useSeenResults.getState().markSeen(data.nodeId, completedAt), selected ? 0 : SEEN_DWELL_MS);
    return () => clearTimeout(timer);
  }, [isUnseen, isLowDetail, isPageVisible, selected, data.nodeId, node?.completedAt]);
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
    <div data-tour="node" data-node-title={node.title} className={`node-wrapper ${selected ? "selected" : ""} ${isDropTarget ? "drop-target" : ""}`} onDragOver={acceptDrop} onDragLeave={() => setIsDropTarget(false)} onDrop={acceptDrop}>
      <div className={`node-card kind-${node.kind} status-${node.status} ${isLowDetail ? "is-low-detail" : ""} ${isLowDetail && blinksForAttention && node.status === "awaiting_approval" ? "is-attention-blink" : ""} ${stale ? "is-stale" : ""} ${isBlocked ? "is-blocked" : ""} ${isUnseen ? "is-unseen" : ""}`} style={{ width: Math.max(size.w, minSizeOf(node.kind).w), height: Math.max(size.h, minSizeOf(node.kind).h), ...tintStyleOf(node.title), ...(isUnseen || node.status === "running" || node.status === "queued" ? ({ "--glow": Math.min(UNSEEN_GLOW_MAX_SCALE, Math.max(1, 1 / zoom)) } as CSSProperties) : {}) }}>
        <FlowHandles node={node} />
        <div className="node-head">
          <TitleLabel node={node} />
          {node.pinned && <span className="pin-mark" title="Pinned: it cannot be moved or resized"><Icon name="pin" /></span>}
          {!isLowDetail && <CommentsChip node={node} zoom={zoom} />}
        </div>
        {isLowDetail && <CommentsChip node={node} zoom={zoom} />}
        {(node.kind === "turn" || node.kind === "subagent") && <Badges node={node} stale={stale} isBlocked={isBlocked} summaryState={summaryState} />}
        {isLowDetail && <div className="lod-title" style={{ fontSize: Math.min(LOW_DETAIL_FONT_SCREEN_PX / zoom, Math.sqrt((node.w * node.h * LOW_DETAIL_FILL) / (Math.max(node.title.length, 1) * LOW_DETAIL_CHAR_ASPECT))) }}>{node.title}</div>}
        {showsBody && <NodeBody node={node} parts={parts} roll={shownRoll} />}
        {showsBody && <RollSwitcher node={node} isViewOnly={isViewOnly} shownRoll={shownRoll} onView={setViewedRoll} />}
        {hiddenCount > 0 && <div className="collapsed-note">{hiddenCount} collapsed</div>}
        {!node.pinned && RESIZE_HANDLES.map(({ className, title, direction }) => <div key={className} className={`resize-handle ${className} nodrag nopan`} onPointerDown={(event) => beginResize(event, direction)} title={title}><span /></div>)}
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
