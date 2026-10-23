import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

interface ScrollPosition {
  top: number;
  left: number;
  isAtEnd: boolean;
}

const STORAGE_KEY = "branchboard.nodeScroll";
const MAX_REMEMBERED = 2000;
const SAVE_DELAY_MS = 400;
const RESTORE_WINDOW_MS = 1000;
const END_TOLERANCE_PX = 4;
const USER_INPUT_EVENTS = ["wheel", "pointerdown", "keydown", "touchstart"] as const;

const isScrollPosition = (value: unknown): value is ScrollPosition => {
  const candidate = value as Partial<ScrollPosition> | null;
  return typeof candidate?.top === "number" && typeof candidate.left === "number" && typeof candidate.isAtEnd === "boolean";
};

const loadPositions = (): Map<string, ScrollPosition> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return new Map(Object.entries(stored ?? {}).filter((entry): entry is [string, ScrollPosition] => isScrollPosition(entry[1])));
  } catch {
    return new Map();
  }
};

const positions = loadPositions();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const savePositions = () => {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(positions)));
  } catch {
    return;
  }
};

addEventListener("pagehide", () => saveTimer !== undefined && savePositions());

const remember = (key: string, element: HTMLElement) => {
  positions.delete(key);
  positions.set(key, { top: element.scrollTop, left: element.scrollLeft, isAtEnd: element.scrollHeight - element.scrollTop - element.clientHeight <= END_TOLERANCE_PX });
  for (const oldest of positions.keys()) {
    if (positions.size <= MAX_REMEMBERED) break;
    positions.delete(oldest);
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePositions, SAVE_DELAY_MS);
};

const applyPosition = (element: HTMLElement, position: ScrollPosition) => {
  element.scrollTop = position.isAtEnd ? element.scrollHeight : position.top;
  element.scrollLeft = position.left;
};

const trackScroll = (target: HTMLElement, key: string) => {
  const saved = positions.get(key);
  const restoreUntil = performance.now() + RESTORE_WINDOW_MS;
  let isRestoring = saved !== undefined;
  let frame = 0;
  const restore = () => {
    if (!saved || !isRestoring) return;
    applyPosition(target, saved);
    if (performance.now() < restoreUntil) frame = requestAnimationFrame(restore);
    else isRestoring = false;
  };
  const stopRestoring = () => {
    isRestoring = false;
    cancelAnimationFrame(frame);
  };
  const record = () => !isRestoring && remember(key, target);
  restore();
  target.addEventListener("scroll", record, { passive: true });
  USER_INPUT_EVENTS.forEach((type) => target.addEventListener(type, stopRestoring, { passive: true }));
  return () => {
    stopRestoring();
    target.removeEventListener("scroll", record);
    USER_INPUT_EVENTS.forEach((type) => target.removeEventListener(type, stopRestoring));
  };
};

const scrollerOf = (element: HTMLElement | null, selector: string | undefined): HTMLElement | null =>
  selector ? (element?.querySelector<HTMLElement>(selector) ?? null) : element;

export const useRememberedScroll = (element: RefObject<HTMLElement | null>, key: string, selector?: string) => {
  useLayoutEffect(() => {
    const searchUntil = performance.now() + RESTORE_WINDOW_MS;
    let frame = 0;
    let stopTracking: (() => void) | undefined;
    const attach = () => {
      const target = scrollerOf(element.current, selector);
      if (target) stopTracking = trackScroll(target, key);
      else if (performance.now() < searchUntil) frame = requestAnimationFrame(attach);
    };
    attach();
    return () => {
      cancelAnimationFrame(frame);
      stopTracking?.();
    };
  }, [element, key, selector]);
};

export const RememberedScroll = ({ scrollKey, selector, children }: { scrollKey: string; selector: string; children: ReactNode }) => {
  const wrapper = useRef<HTMLDivElement>(null);
  useRememberedScroll(wrapper, scrollKey, selector);
  return <div ref={wrapper} className="remembered-scroll">{children}</div>;
};
