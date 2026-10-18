import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icons";

export interface ChipOption {
  value: string;
  label: string;
  group?: string;
  hint?: string;
}

interface ChipSelectLabels {
  search: string;
  noMatches: string;
}

interface ChipSelectProps {
  icon: IconName;
  title: string;
  value: string;
  options: ChipOption[];
  disabled?: boolean;
  labels?: ChipSelectLabels;
  onChange: (value: string) => void;
}

interface MenuPlacement {
  left: number;
  top?: number;
  bottom?: number;
  minWidth: number;
}

const MENU_GAP_PX = 4;
const MENU_MAX_HEIGHT_PX = 320;
const DEFAULT_LABELS: ChipSelectLabels = { search: "Search", noMatches: "No matches" };

const optionText = (option: ChipOption) => (option.group ? `${option.group} · ${option.label}` : option.label);

const placementOf = (box: DOMRect): MenuPlacement => {
  const roomBelow = window.innerHeight - box.bottom;
  const opensUp = roomBelow < MENU_MAX_HEIGHT_PX && box.top > roomBelow;
  return opensUp
    ? { left: box.left, bottom: window.innerHeight - box.top + MENU_GAP_PX, minWidth: box.width }
    : { left: box.left, top: box.bottom + MENU_GAP_PX, minWidth: box.width };
};

export const ChipSelect = ({ icon, title, value, options, disabled = false, labels = DEFAULT_LABELS, onChange }: ChipSelectProps) => {
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [query, setQuery] = useState("");
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const shouldReveal = useRef(false);
  const selected = options.find((option) => option.value === value);
  const isOpen = placement !== null;
  const needle = query.trim().toLowerCase();
  const shown = needle ? options.filter((option) => optionText(option).toLowerCase().includes(needle)) : options;

  const open = () => {
    const box = chipRef.current?.getBoundingClientRect();
    if (!box) return;
    shouldReveal.current = true;
    setQuery("");
    setPlacement(placementOf(box));
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
  };

  const close = () => setPlacement(null);

  const moveActive = (step: number) => {
    if (shown.length === 0) return;
    shouldReveal.current = true;
    setActiveIndex((index) => (index + step + shown.length) % shown.length);
  };

  const search = (text: string) => {
    shouldReveal.current = true;
    setQuery(text);
    setActiveIndex(0);
  };

  useEffect(() => {
    if (!isOpen || !shouldReveal.current) return;
    shouldReveal.current = false;
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
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

  const handleKey = (event: KeyboardEvent) => {
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
      const active = shown[activeIndex];
      if (active) choose(active);
    }
  };

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`chip-select nodrag ${isOpen ? "is-open" : ""}`}
        data-tip={isOpen ? undefined : title}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        disabled={disabled}
        onClick={() => (isOpen ? close() : open())}
        onKeyDown={handleKey}
      >
        <Icon name={icon} />
        <span className="chip-label">{selected?.label ?? value}</span>
        <Icon name="chevronDown" />
      </button>
      {placement && createPortal(
        <div ref={menuRef} className="chip-menu" style={placement}>
          <input
            className="chip-search"
            autoFocus
            value={query}
            spellCheck={false}
            placeholder={`${labels.search}…`}
            aria-label={`${labels.search} ${title}`}
            onChange={(event) => search(event.target.value)}
            onKeyDown={handleKey}
          />
          <ul ref={listRef} role="listbox" aria-label={title}>
            {shown.map((option, index) => (
              <li
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                className={`${index === activeIndex ? "active" : ""} ${option.value === value ? "selected" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
              >
                {optionText(option)}
                {option.hint && <span className="chip-hint">{option.hint}</span>}
              </li>
            ))}
            {shown.length === 0 && <li className="chip-empty">{labels.noMatches}</li>}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
};
