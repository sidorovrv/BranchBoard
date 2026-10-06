export type KeyboardPanMode = "none" | "wasd" | "arrows";

export const KEYBOARD_PAN_MODES: KeyboardPanMode[] = ["none", "wasd", "arrows"];

export interface PanDirection {
  x: number;
  y: number;
}

const DIRECTIONS_BY_MODE: Record<KeyboardPanMode, Record<string, PanDirection>> = {
  none: {},
  wasd: { KeyW: { x: 0, y: -1 }, KeyA: { x: -1, y: 0 }, KeyS: { x: 0, y: 1 }, KeyD: { x: 1, y: 0 } },
  arrows: { ArrowUp: { x: 0, y: -1 }, ArrowLeft: { x: -1, y: 0 }, ArrowDown: { x: 0, y: 1 }, ArrowRight: { x: 1, y: 0 } },
};

export const panDirectionOf = (mode: KeyboardPanMode, code: string): PanDirection | undefined => DIRECTIONS_BY_MODE[mode][code];

export const combinedPanDirection = (mode: KeyboardPanMode, heldCodes: Iterable<string>): PanDirection => {
  const total = { x: 0, y: 0 };
  for (const code of heldCodes) {
    const direction = panDirectionOf(mode, code);
    if (direction) {
      total.x += direction.x;
      total.y += direction.y;
    }
  }
  const length = Math.hypot(total.x, total.y);
  return length === 0 ? total : { x: total.x / length, y: total.y / length };
};
