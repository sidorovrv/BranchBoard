export const REMOTE_TIMEOUT_MS = 5000;

export const fetchRemote = (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Response> =>
  fetch(url, { ...init, signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS), redirect: "error", credentials: "omit" });
