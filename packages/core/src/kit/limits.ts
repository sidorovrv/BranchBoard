export interface LimitWindow {
  id: string;
  utilization: number;
  resetsAt: number;
}

export interface RateLimits {
  status: string;
  windows: LimitWindow[];
  updatedAt: number;
}

export const LIMIT_WARNING_SHARE = 0.6;
export const LIMIT_CRITICAL_SHARE = 0.8;

export const LIMIT_WINDOW_LABELS: Record<string, string> = {
  five_hour: "Session",
  seven_day: "Weekly",
};

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const limitLevel = (utilization: number): "ok" | "warning" | "critical" =>
  utilization >= LIMIT_CRITICAL_SHARE ? "critical" : utilization >= LIMIT_WARNING_SHARE ? "warning" : "ok";

export const limitWindowLabel = (window: LimitWindow): string => LIMIT_WINDOW_LABELS[window.id] ?? window.id;

export const windowAt = (window: LimitWindow, nowMs: number): LimitWindow =>
  window.resetsAt * 1000 <= nowMs ? { ...window, utilization: 0 } : window;

export const formatCountdown = (resetsAtSeconds: number, nowMs: number): string => {
  const minutes = Math.max(0, Math.round((resetsAtSeconds * 1000 - nowMs) / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
};

export const formatAgo = (elapsedMs: number): string => {
  if (elapsedMs < MINUTE_MS) return "just now";
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m ago`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h ago`;
  return `${Math.floor(elapsedMs / DAY_MS)}d ago`;
};

export const limitPercent = (window: LimitWindow): number => Math.round(window.utilization * 100);

export const limitsTitle = (limits: RateLimits, nowMs: number): string => {
  const lines = limits.windows.map((original) => {
    const window = windowAt(original, nowMs);
    const label = limitWindowLabel(window);
    return window === original
      ? `${label}: ${limitPercent(window)}% used, resets in ${formatCountdown(window.resetsAt, nowMs)}`
      : `${label}: 0% used, limit was reset`;
  });
  return [
    ...lines,
    `Limit status: ${limits.status}`,
    `From the last run, ${formatAgo(nowMs - limits.updatedAt)}. Send a message to refresh.`,
  ].join("\n");
};
