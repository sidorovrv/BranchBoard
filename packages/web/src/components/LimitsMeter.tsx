import { useEffect, useState } from "react";
import { formatAgo, formatCost, formatCountdown, formatTokens, type CostSummary, type LimitWindow, type RateLimits } from "@branchboard/core";
import { fetchCosts, fetchLimits } from "../api";

const LIMITS_REFRESH_MS = 10000;
const WINDOW_LABELS: Record<string, string> = { five_hour: "Session", seven_day: "Weekly" };
const HIGH_UTILIZATION = 0.8;
const WARN_UTILIZATION = 0.6;

const levelOf = (utilization: number): string => (utilization >= HIGH_UTILIZATION ? "is-high" : utilization >= WARN_UTILIZATION ? "is-warn" : "is-ok");

const labelOf = (window: LimitWindow): string => WINDOW_LABELS[window.id] ?? window.id;

const describeWindow = (window: LimitWindow, currentTime: number): string =>
  `${labelOf(window)}: ${Math.round(window.utilization * 100)}% used, resets in ${formatCountdown(Math.max(0, window.resetsAt * 1000 - currentTime))}`;

const useLimits = (): RateLimits | undefined => {
  const [limits, setLimits] = useState<RateLimits>();
  useEffect(() => {
    const refresh = () => void fetchLimits().then((latest) => latest && setLimits(latest)).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, LIMITS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return limits;
};

const useCosts = (): CostSummary | undefined => {
  const [costs, setCosts] = useState<CostSummary>();
  useEffect(() => {
    const refresh = () => void fetchCosts().then(setCosts).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, LIMITS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return costs;
};

export const CostMeter = () => {
  const costs = useCosts();
  if (!costs) return null;
  const title = `Cost reported by OpenCode for runs that finished in the last hour.\n${costs.runs} ${costs.runs === 1 ? "run" : "runs"}, ${formatTokens(costs.inputTokens)} input and ${formatTokens(costs.outputTokens)} output tokens.`;
  return (
    <span className="limits" title={title}>
      <span className="limit-window">
        <span className="limit-label">Last hour</span>
        <span className="limit-value cost-value">{formatCost(costs.costUsd)}</span>
      </span>
    </span>
  );
};

export const LimitsMeter = () => {
  const limits = useLimits();
  if (!limits || limits.windows.length === 0) return null;
  const currentTime = Date.now();
  const hasReset = (window: LimitWindow) => window.resetsAt * 1000 <= currentTime;
  const windows = limits.windows.map((window) => (hasReset(window) ? { ...window, utilization: 0 } : window));
  const details = windows.map((window) => describeWindow(window, currentTime));
  const title = `${details.join("\n")}\nLimit status: ${limits.status}\nFrom the last run, ${formatAgo(currentTime - limits.updatedAt)}. Send a message to refresh.`;
  return (
    <span className="limits" title={title}>
      {windows.map((window) => (
        <span key={window.id} className="limit-window">
          <span className="limit-label">{labelOf(window)}</span>
          <span className={`limit-bar ${levelOf(window.utilization)}`} role="progressbar" aria-label={labelOf(window)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.utilization * 100)}>
            <span className="limit-fill" style={{ width: `${Math.min(100, Math.round(window.utilization * 100))}%` }} />
          </span>
          <span className="limit-value">{Math.round(window.utilization * 100)}%</span>
        </span>
      ))}
    </span>
  );
};
