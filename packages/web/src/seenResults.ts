import { useEffect, useState } from "react";
import { create } from "zustand";
import type { GraphNode } from "@branchboard/core";
import { useBoard } from "./store";

const SEEN_KEY = "branchboard.seenResults";
const BASELINE_KEY = "branchboard.seenResultsBaseline";
const MAX_REMEMBERED = 5000;

export const SEEN_DWELL_MS = 1200;

const readSeen = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
};

const readBaseline = (): number => {
  const stored = Number(localStorage.getItem(BASELINE_KEY));
  if (Number.isFinite(stored) && stored > 0) return stored;
  const created = Date.now();
  localStorage.setItem(BASELINE_KEY, String(created));
  return created;
};

const BASELINE = readBaseline();

const trimmed = (seen: Record<string, number>): Record<string, number> => {
  const entries = Object.entries(seen);
  return entries.length <= MAX_REMEMBERED ? seen : Object.fromEntries(entries.slice(entries.length - MAX_REMEMBERED));
};

interface SeenResultsStore {
  seen: Record<string, number>;
  markSeen: (nodeId: string, completedAt: number) => void;
}

export const useSeenResults = create<SeenResultsStore>((set, get) => ({
  seen: readSeen(),
  markSeen: (nodeId, completedAt) => {
    if ((get().seen[nodeId] ?? 0) >= completedAt) return;
    const seen = trimmed({ ...get().seen, [nodeId]: completedAt });
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch {
      return;
    }
    set({ seen });
  },
}));

export const isUnseenCompletion = (completion: { status: string; isStopped: boolean; completedAt: number | undefined }, seenAt: number | undefined): boolean =>
  completion.status === "done" && !completion.isStopped && completion.completedAt !== undefined && completion.completedAt > BASELINE && completion.completedAt > (seenAt ?? 0);

export const isUnseenResult = (node: GraphNode, seenAt: number | undefined): boolean =>
  node.kind === "turn" && isUnseenCompletion({ status: node.status, isStopped: node.stopped === true, completedAt: node.completedAt }, seenAt);

export const useIsUnseenResult = (nodeId: string): boolean => {
  const seenAt = useSeenResults((state) => state.seen[nodeId]);
  return useBoard((state) => {
    const node = state.view.graph.nodes[nodeId];
    return node ? isUnseenResult(node, seenAt) : false;
  });
};

export const usePageVisible = (): boolean => {
  const [isVisible, setIsVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setIsVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return isVisible;
};
