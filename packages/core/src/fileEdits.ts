import type { Part } from "./types";

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

export const diffRows = (before: string, after: string): DiffRow[] => {
  const left = linesOf(before);
  const right = linesOf(after);
  const prefix = commonLength(left, right, false);
  const suffix = commonLength(left.slice(prefix), right.slice(prefix), true);
  const middle = middleRows(left.slice(prefix, left.length - suffix), right.slice(prefix, right.length - suffix));
  const contextBefore = left.slice(Math.max(0, prefix - CONTEXT_LINES), prefix).map((text): DiffRow => ({ kind: "same", text }));
  const contextAfter = left.slice(left.length - suffix, left.length - suffix + CONTEXT_LINES).map((text): DiffRow => ({ kind: "same", text }));
  return [...contextBefore, ...middle, ...contextAfter];
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

export const totalChange = (edits: LineChange[]): LineChange => sumChanges(edits);

export const fileDisplayNames = (paths: string[]): string[] => {
  const segmentsOf = (path: string) => path.split(/[\\/]/).filter(Boolean);
  const names = paths.map((path) => segmentsOf(path).at(-1) ?? path);
  return paths.map((path, index) => (names.filter((name) => name === names[index]).length > 1 ? segmentsOf(path).slice(-2).join("/") : names[index]));
};
