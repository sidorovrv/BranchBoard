import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { buildNodeClipboard, formatDuration, type NodeClipboard, type RunInfo } from "@branchboard/core";
import { fetchBoardView } from "../api";
import { isUnseenCompletion, useSeenResults } from "../seenResults";
import { useSettings } from "../settings";
import { currentViewCentre, sendBoardCommand, useBoard } from "../store";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { ELAPSED_TICK_MS } from "./NodeShell";

type RunFilter = "all" | "active" | "completed";

const FILTERS: { id: RunFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" },
];

const STATUS_LABELS: Record<string, string> = { queued: "Queued", running: "Running", awaiting_approval: "Needs your answer", done: "Done", error: "Failed" };

const goToRun = async (run: RunInfo) => {
  if (run.completedAt !== undefined) useSeenResults.getState().markSeen(run.nodeId, run.completedAt);
  const store = useBoard.getState();
  if (store.board?.id !== run.boardId) await store.openBoard(run.boardId);
  useBoard.getState().requestFocus(run.nodeId);
};

const stopRun = (run: RunInfo) => void useBoard.getState().send({ type: "abort", boardId: run.boardId, nodeId: run.nodeId });

const isUnseenRun = (run: RunInfo, seenAt: number | undefined): boolean => isUnseenCompletion({ status: run.status, isStopped: run.isStopped === true, completedAt: run.completedAt }, seenAt);

const statusLabelOf = (run: RunInfo): string => {
  if (run.isStopping) return "Stopping…";
  if (run.isWaitingForSlot) return "Waiting for a slot";
  if (run.isStopped) return "Stopped";
  return STATUS_LABELS[run.status] ?? run.status;
};

const elapsedOf = (run: RunInfo, now: number): string | undefined => {
  if (run.startedAt === undefined || run.status === "queued") return undefined;
  const end = run.completedAt ?? now;
  return formatDuration(Math.max(0, end - run.startedAt));
};

const clipboardOfRun = async (run: RunInfo): Promise<NodeClipboard | undefined> => {
  const view = await fetchBoardView(run.boardId);
  return buildNodeClipboard(view.graph, view.parts, [run.nodeId]);
};

const copyRun = async (run: RunInfo) => {
  const { notify } = useBoard.getState();
  const clipboard = await clipboardOfRun(run);
  if (!clipboard) return notify("That node no longer exists.");
  await navigator.clipboard.writeText(JSON.stringify(clipboard));
  notify("Copied the node. Paste on any board to duplicate.");
};

const addRunHere = async (run: RunInfo) => {
  const clipboard = await clipboardOfRun(run);
  if (!clipboard) return useBoard.getState().notify("That node no longer exists.");
  const pasted = await sendBoardCommand<{ nodeIds: string[] }>({ type: "pasteNodes", clipboard, position: currentViewCentre() ?? { x: 0, y: 0 } });
  if (pasted) useBoard.getState().requestSelection(pasted.nodeIds);
};

const dotOf = (run: RunInfo, isUnseen: boolean): string => {
  if (run.status === "running") return "is-working";
  if (run.status === "awaiting_approval") return "is-attention";
  if (run.status === "queued") return "is-queued";
  if (run.status === "error") return "is-error";
  return isUnseen ? "is-unseen" : "is-done";
};

const RunRow = ({ run, now, onHide }: { run: RunInfo; now: number; onHide: (run: RunInfo) => void }) => {
  const { open, element } = useContextMenu();
  const seenAt = useSeenResults((state) => state.seen[run.nodeId]);
  const isFinished = run.completedAt !== undefined;
  const isUnseen = isUnseenRun(run, seenAt);
  const elapsed = elapsedOf(run, now);
  const where = [run.projectName, run.boardTitle].filter(Boolean).join(" / ");
  const menu: MenuItem[] = [
    ...(isFinished ? [] : [{ label: run.isStopping ? "Stop again" : "Stop", isDanger: true, run: () => stopRun(run) }]),
    { label: "Copy", run: () => void copyRun(run) },
    { label: "Add here", run: () => void addRunHere(run) },
    { label: "Hide", run: () => onHide(run) },
  ];
  return (
    <li className={`run-row status-${run.status} ${isFinished ? "is-finished" : ""} ${isUnseen ? "is-unseen" : ""}`} onContextMenu={open(menu)}>
      <button className="run-open" onClick={() => void goToRun(run)} title={`${where}\n${run.prompt}\n\nClick to go to the node. Right-click for more.`}>
        <span className={`board-dot ${dotOf(run, isUnseen)}`} aria-hidden="true" />
        <span className="run-text">
          <span className="run-title">{run.title}</span>
          {where && <span className="run-where muted">{where}</span>}
        </span>
        <span className="run-state">
          <span className={`run-status status-${run.status} ${run.isStopped ? "is-stopped" : ""}`}>{statusLabelOf(run)}</span>
          {elapsed && <span className="muted">{elapsed}</span>}
        </span>
      </button>
      {!isFinished && <button className="run-stop" onClick={() => stopRun(run)} title="Stop this run" aria-label={`Stop ${run.title}`}>×</button>}
      {element}
    </li>
  );
};

const dayLabelOf = (completedAt: number): string => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (completedAt >= today) return "Today";
  if (completedAt >= today - 24 * 60 * 60 * 1000) return "Yesterday";
  return new Date(completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const groupedByDay = (runs: RunInfo[]): { label: string; runs: RunInfo[] }[] =>
  runs.reduce<{ label: string; runs: RunInfo[] }[]>((groups, run) => {
    const label = dayLabelOf(run.completedAt ?? 0);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.runs.push(run);
    else groups.push({ label, runs: [run] });
    return groups;
  }, []);

const LIST_BOTTOM_PADDING_PX = 5;

const runKeyOf =(run: RunInfo): string => `${run.boardId}/${run.nodeId}`;

const hideKeyOf = (run: RunInfo): string => `${runKeyOf(run)}@${run.startedAt ?? 0}`;

const RunList = ({ runs, finishedRuns, filter, visibleRows, now, onHide }: { runs: RunInfo[]; finishedRuns: RunInfo[]; filter: RunFilter; visibleRows: number; now: number; onHide: (run: RunInfo) => void }) => {
  const shownActive = filter !== "completed" ? runs : [];
  const shownFinished = filter !== "active" ? finishedRuns : [];
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const rows = element.querySelectorAll<HTMLElement>(".run-row");
    const lastVisible = rows[Math.min(visibleRows, rows.length) - 1];
    if (!lastVisible) return void (element.style.maxHeight = "");
    const neededHeight = lastVisible.getBoundingClientRect().bottom - element.getBoundingClientRect().top + element.scrollTop + LIST_BOTTOM_PADDING_PX;
    element.style.maxHeight = `${Math.ceil(neededHeight)}px`;
  });
  if (shownActive.length === 0 && shownFinished.length === 0) return <div className="muted runs-empty">{filter === "completed" ? "Nothing has finished yet." : "Nothing is running or queued."}</div>;
  return (
    <div className="runs-list nowheel" ref={list}>
      {shownActive.length > 0 && <ul>{shownActive.map((run) => <RunRow key={runKeyOf(run)} run={run} now={now} onHide={onHide} />)}</ul>}
      {groupedByDay(shownFinished).map((group) => (
        <section key={group.label}>
          <h5>{group.label}</h5>
          <ul>{group.runs.map((run) => <RunRow key={runKeyOf(run)} run={run} now={now} onHide={onHide} />)}</ul>
        </section>
      ))}
    </div>
  );
};

export const RunsOverlay = () => {
  const runs = useBoard((state) => state.runs);
  const finishedRuns = useBoard((state) => state.finishedRuns);
  const seen = useSeenResults((state) => state.seen);
  const limit = useSettings((state) => state.settings.activeJobsShown);
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState<RunFilter>("all");
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const { open, element } = useContextMenu();
  useEffect(() => {
    if (!isOpen && runs.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [isOpen, runs.length]);
  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && setIsOpen(false);
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen]);
  const hide = (run: RunInfo) => setHiddenKeys((keys) => new Set(keys).add(hideKeyOf(run)));
  const isListed = (run: RunInfo) => !hiddenKeys.has(hideKeyOf(run));
  const listedRuns = runs.filter(isListed);
  const listedFinished = finishedRuns.filter(isListed);
  const unseenRuns = listedFinished.filter((run) => isUnseenRun(run, seen[run.nodeId]));
  const needsAnswer = listedRuns.some((run) => run.status === "awaiting_approval");
  const markAllSeen = () => unseenRuns.forEach((run) => run.completedAt !== undefined && useSeenResults.getState().markSeen(run.nodeId, run.completedAt));
  const summary = `${listedRuns.length} active ${listedRuns.length === 1 ? "job" : "jobs"}`;
  if (limit === 0) return null;
  return (
    <section className={`runs-overlay ${isOpen ? "is-open" : ""}`} aria-label="Runs">
      <div className="runs-bar">
        <button className={`runs-head ${needsAnswer ? "needs-answer" : ""} ${listedRuns.length > 0 ? "is-working" : ""}`} onClick={() => setIsOpen(!isOpen)} aria-expanded={isOpen} title={unseenRuns.length > 0 ? `${unseenRuns.length} finished and not seen yet` : "Show or hide the jobs list"}>
          <span className="runs-chevron" aria-hidden="true">›</span>
          <span className="runs-summary">{summary}</span>
          {unseenRuns.length > 0 && <span className="runs-unseen-dot" />}
        </button>
        {isOpen && (
          <>
            <div className="runs-filters" role="tablist">
              {FILTERS.map((entry) => (
                <button key={entry.id} role="tab" aria-selected={filter === entry.id} className={filter === entry.id ? "active" : ""} onClick={() => setFilter(entry.id)}>{entry.label}</button>
              ))}
            </div>
            <button className="runs-more-button" onClick={open([{ label: "Mark all as seen", run: markAllSeen }])} title="More" aria-label="More">⋯</button>
          </>
        )}
      </div>
      {isOpen && (
        <>
          <RunList runs={listedRuns} finishedRuns={listedFinished} filter={filter} visibleRows={limit} now={now} onHide={hide} />
        </>
      )}
      {element}
    </section>
  );
};
