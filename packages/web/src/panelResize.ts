import { useState, type PointerEvent as ReactPointerEvent } from "react";

const MIN_ROOM_FOR_BOARD = 360;
const RESIZING_CLASS = "is-resizing-panel";

export const useEdgeResize = (width: number, min: number, max: number, onCommit: (width: number) => void) => {
  const [dragWidth, setDragWidth] = useState<number>();
  const limitFor = () => Math.max(min, Math.min(max, window.innerWidth - MIN_ROOM_FOR_BOARD));
  const clamp = (value: number) => Math.round(Math.min(limitFor(), Math.max(min, value)));
  const beginResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    let latest = width;
    document.body.classList.add(RESIZING_CLASS);
    const move = (moveEvent: PointerEvent) => {
      latest = clamp(width + (startX - moveEvent.clientX));
      setDragWidth(latest);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove(RESIZING_CLASS);
      setDragWidth(undefined);
      onCommit(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const resetWidth = (defaultWidth: number) => onCommit(clamp(defaultWidth));
  return { width: dragWidth ?? Math.min(width, limitFor()), isResizing: dragWidth !== undefined, beginResize, resetWidth };
};
