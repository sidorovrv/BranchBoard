import type { GitChanges, Part } from "./types";

export interface LineChange {
  added: number;
  removed: number;
}

export interface DiffRow {
  kind: "add" | "remove" | "same" | "gap";
  text: string;
}

export interface FileEdit extends LineChange {
  path: string;
  rows: DiffRow[];
}

const PATH_KEYS = ["file_path", "filePath", "path"];
const MAX_DIFF_CELLS = 4_000_000;
const CONTEXT_LINES = 2;

const linesOf = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

const textOf = (input: Record<string, unknown>, keys: string[]): string => {
  const key = keys.find((candidate) => typeof input[candidate] === "string");
  return key ? (input[key] as string) : "";
};

const commonLength = (left: string[], right: string[], fromEnd: boolean): number => {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && (fromEnd ? left[left.length - 1 - length] === right[right.length - 1 - length] : left[length] === right[length])) length += 1;
  return length;
};

const middleRows = (left: string[], right: string[]): DiffRow[] => {
  if (left.length * right.length > MAX_DIFF_CELLS)
    return [...left.map((text): DiffRow => ({ kind: "remove", text })), ...right.map((text): DiffRow => ({ kind: "add", text }))];
  const width = right.length + 1;
  const lengths = new Uint32Array((left.length + 1) * width);
  for (let row = left.length - 1; row >= 0; row -= 1)
    for (let column = right.length - 1; column >= 0; column -= 1)
      lengths[row * width + column] = left[row] === right[column] ? lengths[(row + 1) * width + column + 1] + 1 : Math.max(lengths[(row + 1) * width + column], lengths[row * width + column + 1]);
  const rows: DiffRow[] = [];
  let row = 0;
  let column = 0;
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) {
      rows.push({ kind: "same", text: left[row] });
      row += 1;
      column += 1;
    } else if (lengths[(row + 1) * width + column] >= lengths[row * width + column + 1]) {
      rows.push({ kind: "remove", text: left[row] });
      row += 1;
    } else {
      rows.push({ kind: "add", text: right[column] });
      column += 1;
    }
  }
  left.slice(row).forEach((text) => rows.push({ kind: "remove", text }));
  right.slice(column).forEach((text) => rows.push({ kind: "add", text }));
  return rows;
};

export const diffRows = (before: string, after: string, contextLines = CONTEXT_LINES): DiffRow[] => {
  const left = linesOf(before);
  const right = linesOf(after);
  const prefix = commonLength(left, right, false);
  const suffix = commonLength(left.slice(prefix), right.slice(prefix), true);
  const middle = middleRows(left.slice(prefix, left.length - suffix), right.slice(prefix, right.length - suffix));
  const contextBefore = left.slice(Math.max(0, prefix - contextLines), prefix).map((text): DiffRow => ({ kind: "same", text }));
  const contextAfter = left.slice(left.length - suffix, left.length - suffix + contextLines).map((text): DiffRow => ({ kind: "same", text }));
  return [...contextBefore, ...middle, ...contextAfter];
};

export const gitChangesOf = (rows: DiffRow[]): GitChanges => {
  const added: number[] = [];
  const removedBlocks: GitChanges["removedBlocks"] = [];
  let line = 0;
  for (const row of rows) {
    if (row.kind === "remove") {
      const last = removedBlocks[removedBlocks.length - 1];
      if (last && last.after === line) last.lines.push(row.text);
      else removedBlocks.push({ after: line, lines: [row.text] });
    } else if (row.kind !== "gap") {
      line += 1;
      if (row.kind === "add") added.push(line);
    }
  }
  return { added, removed: removedBlocks.reduce((sum, block) => sum + block.lines.length, 0), removedBlocks };
};

export const rowsOfGitChanges = (content: string, changes: GitChanges): DiffRow[] => {
  const added = new Set(changes.added);
  const removedAfter = (after: number): DiffRow[] => changes.removedBlocks.filter((block) => block.after === after).flatMap((block) => block.lines.map((text): DiffRow => ({ kind: "remove", text })));
  const lines = linesOf(content);
  return [...removedAfter(0), ...lines.flatMap((text, index): DiffRow[] => [{ kind: added.has(index + 1) ? "add" : "same", text }, ...removedAfter(index + 1)])];
};

export const collapseUnchanged = (rows: DiffRow[], contextLines: number): DiffRow[] => {
  const changedIndexes = rows.flatMap((row, index) => (row.kind === "same" ? [] : [index]));
  const isNearChange = (index: number) => changedIndexes.some((changed) => Math.abs(changed - index) <= contextLines);
  return rows.reduce<DiffRow[]>((kept, row, index) => {
    if (row.kind !== "same" || isNearChange(index)) kept.push(row);
    else if (kept[kept.length - 1]?.kind !== "gap") kept.push({ kind: "gap", text: "" });
    return kept;
  }, []);
};

const changeOfRows = (rows: DiffRow[]): LineChange => ({ added: rows.filter((row) => row.kind === "add").length, removed: rows.filter((row) => row.kind === "remove").length });

export const diffLineCounts = (before: string, after: string): LineChange => changeOfRows(diffRows(before, after));

const sumChanges = (changes: LineChange[]): LineChange => ({ added: changes.reduce((sum, change) => sum + change.added, 0), removed: changes.reduce((sum, change) => sum + change.removed, 0) });

const editRecordsOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((edit): edit is Record<string, unknown> => typeof edit === "object" && edit !== null) : [];

const rowsOfRecord = (record: Record<string, unknown>): DiffRow[] => diffRows(textOf(record, ["old_string", "oldString"]), textOf(record, ["new_string", "newString"]));

const joinWithGaps = (groups: DiffRow[][]): DiffRow[] =>
  groups.flatMap((group, index) => (index === 0 ? group : [{ kind: "gap" as const, text: "" }, ...group]));

const rowsOfToolInput = (tool: string, input: Record<string, unknown>): DiffRow[] | undefined => {
  if (tool === "edit") return rowsOfRecord(input);
  if (tool === "write") return linesOf(textOf(input, ["content"])).map((text): DiffRow => ({ kind: "add", text }));
  if (tool === "multiedit" && Array.isArray(input.edits)) return joinWithGaps(editRecordsOf(input.edits).map(rowsOfRecord));
  return undefined;
};

export const fileEditOf = (tool: unknown, input: unknown): FileEdit | undefined => {
  if (typeof tool !== "string" || typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const path = textOf(record, PATH_KEYS);
  const rows = rowsOfToolInput(tool.toLowerCase(), record);
  return path && rows ? { path, rows, ...changeOfRows(rows) } : undefined;
};

export const fileEditsOf = (parts: Part[]): FileEdit[] => {
  const byPath = new Map<string, FileEdit>();
  for (const part of parts) {
    if (part.type !== "tool" || part.meta?.status === "error") continue;
    const edit = fileEditOf(part.meta?.tool, part.meta?.input);
    if (!edit) continue;
    const known = byPath.get(edit.path);
    byPath.set(edit.path, known ? { path: edit.path, rows: joinWithGaps([known.rows, edit.rows]), ...sumChanges([known, edit]) } : edit);
  }
  return [...byPath.values()];
};

export interface EditStep {
  tool: "edit" | "write" | "multiedit";
  input: Record<string, unknown>;
  wasCreated: boolean;
}

const CREATED_PATTERN = /\bcreated\b/i;

export const editStepsByPath = (parts: Part[]): Map<string, EditStep[]> => {
  const byPath = new Map<string, EditStep[]>();
  for (const part of parts) {
    if (part.type !== "tool" || part.meta?.status === "error") continue;
    const edit = fileEditOf(part.meta?.tool, part.meta?.input);
    if (!edit) continue;
    const input = part.meta!.input as Record<string, unknown>;
    const step: EditStep = { tool: String(part.meta!.tool).toLowerCase() as EditStep["tool"], input, wasCreated: CREATED_PATTERN.test(String(part.meta?.output ?? "")) };
    byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), step]);
  }
  return byPath;
};

const undoReplacement = (content: string, record: Record<string, unknown>): string | undefined => {
  const oldText = textOf(record, ["old_string", "oldString"]);
  const newText = textOf(record, ["new_string", "newString"]);
  const replaceAll = record.replace_all === true || record.replaceAll === true;
  const occurrences = newText === "" ? 0 : content.split(newText).length - 1;
  if (occurrences === 0 || (occurrences > 1 && !replaceAll)) return undefined;
  return replaceAll ? content.split(newText).join(oldText) : content.replace(newText, () => oldText);
};

export const contentBeforeSteps = (steps: EditStep[], finalContent: string | null): string | null | undefined => {
  let content = finalContent;
  for (const step of [...steps].reverse()) {
    if (step.tool === "write") {
      if (!step.wasCreated) return undefined;
      content = null;
      continue;
    }
    const records = step.tool === "edit" ? [step.input] : editRecordsOf(step.input.edits);
    for (const record of [...records].reverse()) {
      if (content === null) return undefined;
      const undone = undoReplacement(content, record);
      if (undone === undefined) return undefined;
      content = undone;
    }
  }
  return content;
};

export const totalChange = (edits: LineChange[]): LineChange => sumChanges(edits);

export const fileDisplayNames = (paths: string[]): string[] => {
  const segmentsOf = (path: string) => path.split(/[\\/]/).filter(Boolean);
  const names = paths.map((path) => segmentsOf(path).at(-1) ?? path);
  return paths.map((path, index) => (names.filter((name) => name === names[index]).length > 1 ? segmentsOf(path).slice(-2).join("/") : names[index]));
};
