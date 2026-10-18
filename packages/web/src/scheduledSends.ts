import { useReducer, useEffect } from "react";
import { create } from "zustand";

export interface ScheduledDetails {
  boardId: string;
  title: string;
  prompt: string;
}

interface ScheduledSendStore {
  runAt: Record<string, number>;
  details: Record<string, ScheduledDetails>;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

const withoutKey = <T>(record: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));

export const useScheduledSends = create<ScheduledSendStore>(() => ({ runAt: {}, details: {} }));

export const cancelScheduledSend = (nodeId: string) => {
  clearTimeout(timers.get(nodeId));
  timers.delete(nodeId);
  useScheduledSends.setState(({ runAt, details }) => ({ runAt: withoutKey(runAt, nodeId), details: withoutKey(details, nodeId) }));
};

export const scheduleSend = (nodeId: string, at: number, send: () => unknown, scheduled?: ScheduledDetails) => {
  cancelScheduledSend(nodeId);
  timers.set(nodeId, setTimeout(() => {
    cancelScheduledSend(nodeId);
    void send();
  }, Math.max(0, at - Date.now())));
  useScheduledSends.setState(({ runAt, details }) => ({ runAt: { ...runAt, [nodeId]: at }, details: scheduled ? { ...details, [nodeId]: scheduled } : details }));
};

export const nextOccurrence = (hour: number, minute: number, now: number): number => {
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
};

export const formatRunCountdown = (remainingMs: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export const useNow = (isTicking: boolean): number => {
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    if (!isTicking) return;
    const interval = setInterval(rerender, 1000);
    return () => clearInterval(interval);
  }, [isTicking]);
  return Date.now();
};
