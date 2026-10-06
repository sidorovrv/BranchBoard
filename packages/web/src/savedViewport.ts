import type { Viewport } from "@xyflow/react";

const keyFor = (boardId: string) => `branchboard.viewport.${boardId}`;

const isFiniteViewport = (value: unknown): value is Viewport => {
  const candidate = value as Partial<Viewport> | null;
  return [candidate?.x, candidate?.y, candidate?.zoom].every((part) => typeof part === "number" && Number.isFinite(part)) && candidate!.zoom! > 0;
};

export const loadViewport = (boardId: string): Viewport | undefined => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(keyFor(boardId)) ?? "null");
    return isFiniteViewport(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const saveViewport = (boardId: string, viewport: Viewport) => {
  try {
    localStorage.setItem(keyFor(boardId), JSON.stringify({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }));
  } catch {
    return;
  }
};
