import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icons";

export interface ChipOption {
  value: string;
  label: string;
  group?: string;
}

interface ChipSelectProps {
  icon: IconName;
  title: string;
  value: string;
  options: ChipOption[];
  onChange: (value: string) => void;
}

interface MenuPlacement {
  left: number;
  top: number;
  minWidth: number;
}

const MENU_GAP_PX = 4;

const optionText = (option: ChipOption) => (option.group ? `${option.group} · ${option.label}` : option.label);

export const ChipSelect = ({ icon, title, value, options, onChange }: ChipSelectProps) => {
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const shouldReveal = useRef(false);
  const selected = options.find((option) => option.value === value);
  const isOpen = placement !== null;

  const open = () => {
    const box = chipRef.current?.getBoundingClientRect();
    if (!box) return;
    shouldReveal.current = true;
    setPlacement({ left: box.left, top: box.bottom + MENU_GAP_PX, minWidth: box.width });
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
  };

  const close = () => setPlacement(null);

  const moveActive = (step: number) => {
    shouldReveal.current = true;
    setActiveIndex((index) => (index + step + options.length) % options.length);
  };

  useEffect(() => {
    if (!isOpen || !shouldReveal.current) return;
    shouldReveal.current = false;
    menuRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [isOpen, activeIndex]);

  const choose = (option: ChipOption) => {
    close();
    if (option.value !== value) onChange(option.value);
    chipRef.current?.focus();
  };

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      close();
    };
    const closeOnViewportChange = () => close();
    const closeOnWheelOutside = (event: WheelEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const keepWheelInsideMenu = (event: WheelEvent) => {
      if (event.ctrlKey) event.preventDefault();
      event.stopPropagation();
    };
    const menu = menuRef.current;
    window.addEventListener("pointerdown", closeOnOutside, true);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("wheel", closeOnWheelOutside, true);
    menu?.addEventListener("wheel", keepWheelInsideMenu, { passive: false });
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside, true);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("wheel", closeOnWheelOutside, true);
      menu?.removeEventListener("wheel", keepWheelInsideMenu);
    };
  }, [isOpen]);

  const handleKey = (event: React.KeyboardEvent) => {
    if (!isOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        open();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      choose(options[activeIndex]);
    }
  };

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`chip-select nodrag ${isOpen ? "is-open" : ""}`}
        title={title}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => (isOpen ? close() : open())}
        onKeyDown={handleKey}
      >
        <Icon name={icon} />
        <span className="chip-label">{selected?.label ?? value}</span>
        <Icon name="chevronDown" />
      </button>
      {placement && createPortal(
        <ul ref={menuRef} className="chip-menu" role="listbox" aria-label={title} style={{ left: placement.left, top: placement.top, minWidth: placement.minWidth }}>
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`${index === activeIndex ? "active" : ""} ${option.value === value ? "selected" : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
            >
              {optionText(option)}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </>
  );
};
