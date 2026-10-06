import { useEffect, useMemo, useState } from "react";
import { filterCommands } from "@branchboard/core";
import { fetchWorkspaceFiles } from "../api";
import { useBoard } from "../store";

export type PickerKind = "command" | "mention";

export interface PickerTrigger {
  kind: PickerKind;
  start: number;
  query: string;
}

export interface PickerItem {
  value: string;
  label: string;
  detail?: string;
}

const COMMAND_PATTERN = /^\/([\w:.-]*)$/;
const MENTION_PATTERN = /(?:^|\s)@([^\s@]*)$/;
const FILE_SEARCH_DELAY_MS = 150;
const MAX_ITEMS = 8;

export const triggerAt = (text: string, caret: number): PickerTrigger | undefined => {
  const before = text.slice(0, caret);
  const command = COMMAND_PATTERN.exec(before);
  if (command) return { kind: "command", start: 0, query: command[1] };
  const mention = MENTION_PATTERN.exec(before);
  return mention ? { kind: "mention", start: caret - mention[1].length - 1, query: mention[1] } : undefined;
};

export const insertPick = (text: string, caret: number, trigger: PickerTrigger, item: PickerItem): { text: string; caret: number } => {
  const marker = trigger.kind === "command" ? "/" : "@";
  const inserted = `${marker}${item.value} `;
  const next = `${text.slice(0, trigger.start)}${inserted}${text.slice(caret)}`;
  return { text: next, caret: trigger.start + inserted.length };
};

const useWorkspaceFiles = (query: string, isActive: boolean): string[] => {
  const boardId = useBoard((state) => state.board?.id);
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!isActive || !boardId) return setFiles([]);
    let isCancelled = false;
    const timer = setTimeout(() => {
      fetchWorkspaceFiles(boardId, query).then(
        (found) => !isCancelled && setFiles(found),
        () => !isCancelled && setFiles([]),
      );
    }, FILE_SEARCH_DELAY_MS);
    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [boardId, query, isActive]);
  return files;
};

export const usePickerItems = (trigger: PickerTrigger | undefined): PickerItem[] => {
  const catalog = useBoard((state) => state.catalog);
  const files = useWorkspaceFiles(trigger?.query ?? "", trigger?.kind === "mention");
  return useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "command") return filterCommands(catalog?.commands ?? [], trigger.query).map((command) => ({ value: command.name, label: `/${command.name}`, detail: command.description }));
    const agents = (catalog?.agents ?? [])
      .filter((agent) => agent !== "default" && agent.toLowerCase().startsWith(trigger.query.toLowerCase()))
      .map((agent) => ({ value: agent, label: `@${agent}`, detail: "Use this agent for the run" }));
    return [...agents, ...files.map((path) => ({ value: path, label: path, detail: "Attach this file for the run" }))].slice(0, MAX_ITEMS);
  }, [trigger, catalog, files]);
};

export const ComposerPicker = ({ items, activeIndex, onPick }: { items: PickerItem[]; activeIndex: number; onPick: (item: PickerItem) => void }) => {
  if (items.length === 0) return null;
  return (
    <ul className="composer-picker" role="listbox">
      {items.map((item, index) => (
        <li key={item.value} role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "active" : ""} onMouseDown={(event) => (event.preventDefault(), onPick(item))}>
          <span className="picker-label">{item.label}</span>
          {item.detail && <span className="muted picker-detail">{item.detail}</span>}
        </li>
      ))}
    </ul>
  );
};
