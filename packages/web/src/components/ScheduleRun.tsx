import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { listenForEscape } from "../escape";
import { nextOccurrence } from "../scheduledSends";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTES = Array.from({ length: 60 }, (_, minute) => minute);
const twoDigits = (value: number) => String(value).padStart(2, "0");

const nextFullHour = () => {
  const next = new Date();
  next.setHours(next.getHours() + 1, 0, 0, 0);
  return next.getTime();
};

interface TimeColumnProps {
  label: string;
  values: number[];
  selected: number;
  onSelect: (value: number) => void;
}

const TimeColumn = ({ label, values, selected, onSelect }: TimeColumnProps) => {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const current = list.current?.querySelector<HTMLElement>(".selected");
    if (list.current && current) list.current.scrollTop = current.offsetTop - (list.current.clientHeight - current.clientHeight) / 2;
  }, []);
  return (
    <ul className="schedule-column" ref={list} role="listbox" aria-label={label}>
      {values.map((value) => (
        <li key={value} role="option" aria-selected={value === selected} className={value === selected ? "selected" : undefined} tabIndex={0} onClick={() => onSelect(value)} onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), onSelect(value))}>
          {twoDigits(value)}
        </li>
      ))}
    </ul>
  );
};

const useDismiss = (onClose: () => void, panel?: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const closeOnOutsidePress = (event: MouseEvent) => {
      const target = event.target as Element;
      if (panel && !panel.current?.contains(target) && !target.closest(".send-split")) onClose();
    };
    document.addEventListener("mousedown", closeOnOutsidePress);
    const stopListeningForEscape = listenForEscape(onClose);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePress);
      stopListeningForEscape();
    };
  }, [onClose, panel]);
};

interface AnchoredPanelProps {
  className: string;
  label: string;
  role: string;
  panel: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

const AnchoredPanel = ({ className, label, role, panel, children }: AnchoredPanelProps) => {
  const marker = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ right: number; bottom: number }>();
  useLayoutEffect(() => {
    const anchor = marker.current?.closest(".composer")?.querySelector(".send-options");
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    setPosition({ right: window.innerWidth - box.right, bottom: window.innerHeight - box.top + 6 });
  }, []);
  return (
    <>
      <span ref={marker} hidden />
      {position && createPortal(<div className={`anchored-panel ${className}`} ref={panel} role={role} aria-label={label} style={position}>{children}</div>, document.body)}
    </>
  );
};

interface SendMenuProps {
  onSchedule: () => void;
  onClose: () => void;
}

export const SendMenu = ({ onSchedule, onClose }: SendMenuProps) => {
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(onClose, panel);
  return (
    <AnchoredPanel className="send-menu" label="Send options" role="menu" panel={panel}>
      <button role="menuitem" onClick={onSchedule}>Schedule run</button>
    </AnchoredPanel>
  );
};

interface ScheduleRunDialogProps {
  scheduledAt?: number;
  onSchedule: (at: number) => void;
  onUnschedule: () => void;
  onClose: () => void;
}

export const ScheduleRunDialog = ({ scheduledAt, onSchedule, onUnschedule, onClose }: ScheduleRunDialogProps) => {
  const initial = new Date(scheduledAt ?? nextFullHour());
  const [hour, setHour] = useState(initial.getHours());
  const [minute, setMinute] = useState(initial.getMinutes());
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(onClose, panel);

  return (
    <AnchoredPanel className="schedule-dialog" label="Schedule run" role="dialog" panel={panel}>
      <div className="schedule-title">Run at</div>
      <div className="schedule-time">
        <TimeColumn label="Hour" values={HOURS} selected={hour} onSelect={setHour} />
        <span>:</span>
        <TimeColumn label="Minute" values={MINUTES} selected={minute} onSelect={setMinute} />
      </div>
      <div className="schedule-actions">
        <button className="primary" onClick={() => onSchedule(nextOccurrence(hour, minute, Date.now()))}>Schedule run</button>
        {scheduledAt !== undefined && <button onClick={onUnschedule}>Unschedule</button>}
      </div>
    </AnchoredPanel>
  );
};
