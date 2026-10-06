import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

const EDGE_GAP = 8;

export interface MenuItem {
  label: string;
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
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", closeOnOutsidePress, true);
    window.addEventListener("mousedown", closeOnOutsidePress, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress, true);
      window.removeEventListener("mousedown", closeOnOutsidePress, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);
  return createPortal(
    <div ref={element} className="context-menu" style={{ left: position.x, top: position.y }} onMouseDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
      {menu.items.map((item, index) => (
        <button key={index} className={item.isDanger ? "danger" : ""} onClick={() => (onClose(), item.run())}>{item.label}</button>
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
