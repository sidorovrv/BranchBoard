import { Fragment, useEffect, useState } from "react";
import { COST_WINDOWS, formatAgo, formatCost, formatCountdown, formatTokens, type CostSummary, type LimitWindow, type RateLimits } from "@branchboard/core";
import { fetchCosts, fetchLimits } from "../api";
import { useSettings } from "../settings";

const LIMITS_REFRESH_MS = 10000;
const COSTS_REFRESH_MS = 3000;
const WINDOW_LABELS: Record<string, string> = { five_hour: "Session", seven_day: "Weekly" };
const HIGH_UTILIZATION = 0.8;
const WARN_UTILIZATION = 0.6;

const levelOf = (utilization: number): string => (utilization >= HIGH_UTILIZATION ? "is-high" : utilization >= WARN_UTILIZATION ? "is-warn" : "is-ok");

const labelOf = (window: LimitWindow): string => WINDOW_LABELS[window.id] ?? window.id;

const describeWindow = (window: LimitWindow, currentTime: number): string =>
  `${labelOf(window)}: ${Math.round(window.utilization * 100)}% used, resets in ${formatCountdown(window.resetsAt, currentTime)}`;

const useLimits = (runtime: string): RateLimits | undefined => {
  const [limits, setLimits] = useState<RateLimits>();
  useEffect(() => {
    setLimits(undefined);
    const refresh = () => void fetchLimits(runtime).then((latest) => latest && setLimits(latest)).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, LIMITS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [runtime]);
  return limits;
};

const useCosts = (isEnabled: boolean): CostSummary[] | undefined => {
  const [costs, setCosts] = useState<CostSummary[]>();
  useEffect(() => {
    if (!isEnabled) return;
    const refresh = () => void fetchCosts().then(setCosts).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, COSTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [isEnabled]);
  return costs;
};

const describeCost = (summary: CostSummary, label: string): string =>
  `${label}: ${formatCost(summary.costUsd)}, ${summary.runs} ${summary.runs === 1 ? "run" : "runs"}, ${formatTokens(summary.inputTokens)} input and ${formatTokens(summary.outputTokens)} output tokens`;

export const CostMeter = () => {
  const shown = useSettings((state) => state.settings.costWindows);
  const windows = COST_WINDOWS.filter((window) => shown.includes(window.id));
  const costs = useCosts(windows.length > 0);
  if (!costs || windows.length === 0) return null;
  const summaryOf = (id: string) => costs.find((summary) => summary.id === id);
  const title = ["Cost reported by OpenCode for the last hour, day, week and 30 days, including runs that are still going.", ...windows.flatMap((window) => { const summary = summaryOf(window.id); return summary ? [describeCost(summary, window.label)] : []; })].join("\n");
  return (
    <span className="limits" title={title}>
      {windows.map((window, index) => (
        <Fragment key={window.id}>
          {index > 0 && <span className="limit-separator">/</span>}
          <span className="limit-value cost-value">{formatCost(summaryOf(window.id)?.costUsd ?? 0)}/{window.unit}</span>
        </Fragment>
      ))}
    </span>
  );
};

export const LimitsMeter = ({ runtime }: { runtime: string }) => {
  const limits = useLimits(runtime);
  if (!limits || limits.windows.length === 0) return null;
  const currentTime = Date.now();
  const hasReset = (window: LimitWindow) => window.resetsAt * 1000 <= currentTime;
  const windows = limits.windows.map((window) => (hasReset(window) ? { ...window, utilization: 0 } : window));
  const details = windows.map((window) => describeWindow(window, currentTime));
  const title = `${details.join("\n")}\nLimit status: ${limits.status}\nFrom the last run, ${formatAgo(currentTime - limits.updatedAt)}. Send a message to refresh.`;
  return (
    <span className="limits" title={title}>
      {windows.map((window, index) => (
        <Fragment key={window.id}>
          {index > 0 && <span className="limit-separator">/</span>}
          <span className={`limit-value ${levelOf(window.utilization)}`} aria-label={`${labelOf(window)}: ${Math.round(window.utilization * 100)}% used`}>{Math.round(window.utilization * 100)}%</span>
        </Fragment>
      ))}
    </span>
  );
};
