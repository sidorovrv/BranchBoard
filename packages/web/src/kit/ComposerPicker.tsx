import { useEffect, useMemo, useState } from "react";
import { filterCommands, type CatalogCommand } from "@branchboard/core";

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
  preview?: string;
}

export interface PickerCatalog {
  commands: CatalogCommand[];
  agents?: string[];
  subagents?: string[];
  skills?: { id: string; description?: string }[];
}

export interface PickerSource {
  catalog: PickerCatalog | undefined;
  searchFiles: ((query: string) => Promise<string[]>) | undefined;
}

const COMMAND_PATTERN = /^\/([\w:.-]*)$/;
const MENTION_PATTERN = /(?:^|\s)@([^\s@]*)$/;
const FILE_SEARCH_DELAY_MS = 150;
const MAX_ITEMS = 8;
const TEMPLATE_PREVIEW_CHARS = 120;

export const triggerAt = (text: string, caret: number): PickerTrigger | undefined => {
  const before = text.slice(0, caret);
  const command = COMMAND_PATTERN.exec(before);
  if (command) return { kind: "command", start: 0, query: command[1] ?? "" };
  const query = MENTION_PATTERN.exec(before)?.[1];
  return query === undefined ? undefined : { kind: "mention", start: caret - query.length - 1, query };
};

export const insertPick = (text: string, caret: number, trigger: PickerTrigger, item: PickerItem): { text: string; caret: number } => {
  const marker = trigger.kind === "command" ? "/" : "@";
  const inserted = `${marker}${item.value} `;
  const next = `${text.slice(0, trigger.start)}${inserted}${text.slice(caret)}`;
  return { text: next, caret: trigger.start + inserted.length };
};

const useFoundFiles = (query: string, isActive: boolean, searchFiles: PickerSource["searchFiles"]): string[] => {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!isActive || !searchFiles) return setFiles([]);
    let isCancelled = false;
    const timer = setTimeout(() => {
      searchFiles(query).then(
        (found) => !isCancelled && setFiles(found),
        () => !isCancelled && setFiles([]),
      );
    }, FILE_SEARCH_DELAY_MS);
    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [searchFiles, query, isActive]);
  return files;
};

const commandDetail = (command: CatalogCommand): string =>
  [command.description, command.agent && `agent ${command.agent}`, command.model && `model ${command.model}`, command.subagent && "runs as subagent"].filter(Boolean).join(" · ");

export const usePickerItems = (trigger: PickerTrigger | undefined, { catalog, searchFiles }: PickerSource): PickerItem[] => {
  const files = useFoundFiles(trigger?.query ?? "", trigger?.kind === "mention", searchFiles);
  return useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "command")
      return filterCommands(catalog?.commands ?? [], trigger.query)
        .slice(0, MAX_ITEMS)
        .map((command) => ({ value: command.name, label: `/${command.name}`, detail: commandDetail(command), preview: command.template.slice(0, TEMPLATE_PREVIEW_CHARS) }));
    const matches = (name: string) => name !== "default" && name.toLowerCase().startsWith(trigger.query.toLowerCase());
    const agents = (catalog?.agents ?? []).filter(matches).map((agent) => ({ value: agent, label: `@${agent}`, detail: "Use this agent for the run" }));
    const subagents = (catalog?.subagents ?? []).filter(matches).map((agent) => ({ value: agent, label: `@${agent}`, detail: "Ask this subagent for the run" }));
    const skills = (catalog?.skills ?? []).filter((skill) => matches(skill.id)).map((skill) => ({ value: skill.id, label: `@${skill.id}`, detail: skill.description ?? "Load this skill for the run" }));
    return [...agents, ...subagents, ...skills, ...files.map((path) => ({ value: path, label: path, detail: "Attach this file for the run" }))].slice(0, MAX_ITEMS);
  }, [trigger, catalog, files]);
};

interface ComposerPickerProps {
  items: PickerItem[];
  activeIndex: number;
  label?: string;
  emptyText?: string;
  onPick: (item: PickerItem) => void;
}

export const ComposerPicker = ({ items, activeIndex, label, emptyText, onPick }: ComposerPickerProps) => {
  if (items.length === 0 && !emptyText) return null;
  return (
    <ul className="composer-picker" role="listbox" aria-label={label}>
      {items.length === 0 && <li className="muted">{emptyText}</li>}
      {items.map((item, index) => (
        <li key={item.value} role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "active" : ""} onMouseDown={(event) => (event.preventDefault(), onPick(item))}>
          <span className="picker-label">{item.label}</span>
          {item.detail && <span className="muted picker-detail">{item.detail}</span>}
          {item.preview && <span className="muted picker-detail picker-preview">{item.preview}</span>}
        </li>
      ))}
    </ul>
  );
};
