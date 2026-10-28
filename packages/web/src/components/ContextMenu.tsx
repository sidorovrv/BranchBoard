import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { listenForEscape } from "../escape";
import { IconRow, type IconName } from "../kit/Icons";

const EDGE_GAP = 8;

const TEXT_FIELD_SELECTOR = "input, textarea, [contenteditable='true']";

export const keepNativeMenuOnTextFields = (event: MouseEvent) => {
  if ((event.target as Element).closest(TEXT_FIELD_SELECTOR)) return event.stopPropagation();
  event.preventDefault();
};

export interface MenuItem {
  label: string;
  icons?: IconName[];
  isDanger?: boolean;
  run: () => void;
}

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

const ContextMenu = ({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) => {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const bounds = element.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({ x: Math.max(EDGE_GAP, Math.min(menu.x, window.innerWidth - bounds.width - EDGE_GAP)), y: Math.max(EDGE_GAP, Math.min(menu.y, window.innerHeight - bounds.height - EDGE_GAP)) });
  }, [menu]);
  useEffect(() => {
    const close = () => onClose();
    const closeOnOutsidePress = (event: Event) => {
      if (!element.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePress, true);
    window.addEventListener("mousedown", closeOnOutsidePress, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("blur", close);
    const stopListeningForEscape = listenForEscape(close);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress, true);
      window.removeEventListener("mousedown", closeOnOutsidePress, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("blur", close);
      stopListeningForEscape();
    };
  }, [onClose]);
  return createPortal(
    <div ref={element} className="context-menu" style={{ left: position.x, top: position.y }} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => (event.stopPropagation(), keepNativeMenuOnTextFields(event))}>
      {menu.items.map((item, index) => (
        <button key={index} className={item.isDanger ? "danger" : ""} onClick={() => (onClose(), item.run())}>
          {item.icons && <IconRow names={item.icons} />}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
};

export const useContextMenu = () => {
  const [menu, setMenu] = useState<OpenMenu>();
  const open = (items: MenuItem[]) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };
  const element = menu ? <ContextMenu menu={menu} onClose={() => setMenu(undefined)} /> : null;
  return { open, element };
};
