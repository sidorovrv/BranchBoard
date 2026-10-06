import { liveNodes } from "@branchboard/core";
import { useSettings } from "./settings";
import { useBoard } from "./store";

const SAMPLE_MS = 5000;
const LAG_PROBE_MS = 500;
const SLOW_TASK_MS = 50;
const TOP_ANIMATIONS = 6;
const TOP_LONG_TASKS = 3;
const BYTES_PER_MEGABYTE = 1024 * 1024;

const roundTo = (value: number, digits = 1): number => Math.round(value * 10 ** digits) / 10 ** digits;

const zoomOfViewport = (): number | null => {
  const transform = document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
  const scale = /scale\(([\d.]+)\)/.exec(transform)?.[1];
  return scale ? roundTo(Number(scale), 2) : null;
};

const runningAnimations = (): { total: number; byName: Record<string, number> } => {
  const counts = new Map<string, number>();
  const animations = document.getAnimations().filter((animation) => animation.playState === "running");
  for (const animation of animations) {
    const name = animation instanceof CSSAnimation ? animation.animationName : animation instanceof CSSTransition ? `transition:${animation.transitionProperty}` : "script";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, TOP_ANIMATIONS);
  return { total: animations.length, byName: Object.fromEntries(top) };
};

const boardSnapshot = () => {
  const { board, view, selectedIds, runs } = useBoard.getState();
  const nodes = liveNodes(view.graph);
  const { theme, isSidebarOpen, isContextPanelOpen } = useSettings.getState().settings;
  return {
    boardId: board?.id ?? null,
    nodes: nodes.length,
    nodesRunning: nodes.filter((node) => node.status === "running").length,
    nodesWaiting: nodes.filter((node) => node.status === "awaiting_approval").length,
    runsListed: runs.length,
    selected: selectedIds.length,
    zoom: zoomOfViewport(),
    renderedNodeElements: document.querySelectorAll(".react-flow__node").length,
    theme,
    isSidebarOpen,
    isContextPanelOpen,
  };
};

interface IntervalCounters {
  longTaskDurations: number[];
  maxTimerLagMs: number;
  storeUpdates: number;
  pointerMoves: number;
  wheels: number;
  keys: number;
}

const freshCounters = (): IntervalCounters => ({ longTaskDurations: [], maxTimerLagMs: 0, storeUpdates: 0, pointerMoves: 0, wheels: 0, keys: 0 });

const observeLongTasks = (onTask: (durationMs: number) => void): (() => void) => {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return () => undefined;
  const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => onTask(entry.duration)));
  observer.observe({ type: "longtask", buffered: false });
  return () => observer.disconnect();
};

const sendSample = (sample: Record<string, unknown>) => {
  void fetch("/api/perf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sample), keepalive: true }).catch(() => undefined);
};

export const startPerfMonitor = (): (() => void) => {
  let counters = freshCounters();
  let lastLagProbeAt = performance.now();

  const stopLongTasks = observeLongTasks((durationMs) => {
    if (durationMs >= SLOW_TASK_MS) counters.longTaskDurations.push(roundTo(durationMs, 0));
  });
  const stopStoreWatch = useBoard.subscribe(() => counters.storeUpdates++);
  const countPointerMove = () => counters.pointerMoves++;
  const countWheel = () => counters.wheels++;
  const countKey = () => counters.keys++;
  window.addEventListener("pointermove", countPointerMove, { passive: true, capture: true });
  window.addEventListener("wheel", countWheel, { passive: true, capture: true });
  window.addEventListener("keydown", countKey, { passive: true, capture: true });

  const lagProbe = setInterval(() => {
    const now = performance.now();
    if (document.visibilityState === "visible") counters.maxTimerLagMs = Math.max(counters.maxTimerLagMs, now - lastLagProbeAt - LAG_PROBE_MS);
    lastLagProbeAt = now;
  }, LAG_PROBE_MS);

  const sampleTimer = setInterval(() => {
    const finished = counters;
    counters = freshCounters();
    const heapBytes = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const slowest = [...finished.longTaskDurations].sort((left, right) => right - left);
    sendSample({
      isVisible: document.visibilityState === "visible",
      hasFocus: document.hasFocus(),
      longTaskCount: slowest.length,
      longTaskTotalMs: slowest.reduce((total, duration) => total + duration, 0),
      longTaskWorstMs: slowest.slice(0, TOP_LONG_TASKS),
      maxTimerLagMs: roundTo(Math.max(0, finished.maxTimerLagMs), 0),
      storeUpdates: finished.storeUpdates,
      pointerMoves: finished.pointerMoves,
      wheels: finished.wheels,
      keys: finished.keys,
      heapUsedMb: heapBytes === undefined ? null : roundTo(heapBytes / BYTES_PER_MEGABYTE),
      domElements: document.getElementsByTagName("*").length,
      animations: runningAnimations(),
      ...boardSnapshot(),
    });
  }, SAMPLE_MS);

  return () => {
    stopLongTasks();
    stopStoreWatch();
    window.removeEventListener("pointermove", countPointerMove, { capture: true });
    window.removeEventListener("wheel", countWheel, { capture: true });
    window.removeEventListener("keydown", countKey, { capture: true });
    clearInterval(lagProbe);
    clearInterval(sampleTimer);
  };
};
