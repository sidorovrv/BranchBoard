import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import { boundActionId, combinedPanDirection, keyBindingOf, panDirectionOf } from "@branchboard/core";
import { isTextField } from "./nodeClipboard";
import { useSettings } from "./settings";

const PAN_SPEED_PX_PER_SECOND = 900;
const MAX_FRAME_SECONDS = 0.05;
const FIRST_FRAME_SECONDS = 1 / 60;
const BLOCKING_LAYERS = ".dialog-backdrop, .image-overlay, .chip-menu, .context-menu";

const isBlocked = (event: KeyboardEvent): boolean =>
  event.ctrlKey || event.metaKey || event.altKey || isTextField(event.target) || document.querySelector(BLOCKING_LAYERS) !== null;

const isBoundToAction = (event: KeyboardEvent): boolean => {
  const pressed = keyBindingOf(event);
  return pressed !== undefined && boundActionId(useSettings.getState().settings.keybinds, pressed) !== undefined;
};

export const useKeyboardPan = () => {
  const { getViewport, setViewport } = useReactFlow();
  const mode = useSettings((state) => state.settings.keyboardPan);
  useEffect(() => {
    if (mode === "none") return;
    const held = new Set<string>();
    const pressedSinceFrame = new Set<string>();
    let frame = 0;
    let lastTime = 0;
    let exact: { x: number; y: number } | undefined;
    const step = (time: number) => {
      const seconds = Math.min(MAX_FRAME_SECONDS, (time - lastTime) / 1000);
      lastTime = time;
      const direction = combinedPanDirection(mode, [...held, ...pressedSinceFrame]);
      pressedSinceFrame.clear();
      if (direction.x !== 0 || direction.y !== 0) {
        const { x, y, zoom } = getViewport();
        const distance = PAN_SPEED_PX_PER_SECOND * (useSettings.getState().settings.keyboardPanSpeed / 100) * seconds;
        const from = exact && Math.round(exact.x) === x && Math.round(exact.y) === y ? exact : { x, y };
        exact = { x: from.x - direction.x * distance, y: from.y - direction.y * distance };
        void setViewport({ x: Math.round(exact.x), y: Math.round(exact.y), zoom });
      }
      frame = held.size > 0 ? requestAnimationFrame(step) : 0;
    };
    const press = (event: KeyboardEvent) => {
      if (!panDirectionOf(mode, event.code) || isBlocked(event) || isBoundToAction(event)) return;
      event.preventDefault();
      held.add(event.code);
      pressedSinceFrame.add(event.code);
      if (frame === 0) {
        lastTime = performance.now() - FIRST_FRAME_SECONDS * 1000;
        frame = requestAnimationFrame(step);
      }
    };
    const release = (event: KeyboardEvent) => void held.delete(event.code);
    const releaseAll = () => held.clear();
    window.addEventListener("keydown", press);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", releaseAll);
    return () => {
      window.removeEventListener("keydown", press);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", releaseAll);
      cancelAnimationFrame(frame);
    };
  }, [mode, getViewport, setViewport]);
};
