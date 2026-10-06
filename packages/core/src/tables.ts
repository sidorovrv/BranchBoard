export type ColumnType = "text" | "number" | "currency" | "percent" | "date";
export type SortDirection = "asc" | "desc";
export type SortValue = number | string | undefined;

export interface TableColumn {
  label: string;
  type: ColumnType;
}

export interface TableRow {
  cells: string[];
  sortValues: SortValue[];
}

export interface TableData {
  title?: string;
  columns: TableColumn[];
  rows: TableRow[];
  initialSort?: { column: number; direction: SortDirection };
}

export type TableParse = { table: TableData } | { error: string };

const MAX_TABLE_ROWS = 5000;
const MAX_TABLE_COLUMNS = 60;
const NUMBER_PATTERN = /^[-+]?\d+(\.\d+)?$/;
const THOUSANDS_PATTERN = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[-+]\d{2}:?\d{2})?)?$/;
const COLUMN_TYPES: ColumnType[] = ["text", "number", "currency", "percent", "date"];

export const parseNumber = (text: string): number | undefined => {
  const cleaned = text
    .trim()
    .replace(/[−–]/g, "-")
    .replace(/^([-+]?)[$€£¥]\s*/, "$1")
    .replace(/\s*%$/, "");
  if (NUMBER_PATTERN.test(cleaned)) return Number(cleaned);
  if (THOUSANDS_PATTERN.test(cleaned)) return Number(cleaned.replace(/,/g, ""));
  return undefined;
};

export const parseDate = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (!ISO_DATE_PATTERN.test(trimmed)) return undefined;
  const time = Date.parse(trimmed);
  return Number.isNaN(time) ? undefined : time;
};

const isBlank = (cell: string): boolean => cell.trim() === "";

const columnTypeOfCells = (cells: string[]): ColumnType => {
  const filled = cells.filter((cell) => !isBlank(cell));
  if (filled.length === 0) return "text";
  if (filled.every((cell) => parseNumber(cell) !== undefined)) return "number";
  if (filled.every((cell) => parseDate(cell) !== undefined)) return "date";
  return "text";
};

const sortValueOf = (cell: string, type: ColumnType): SortValue => {
  if (isBlank(cell)) return undefined;
  if (type === "date") return parseDate(cell);
  if (type === "text") return cell.trim().toLowerCase();
  return parseNumber(cell);
};

export const tableFromText = (header: string[], bodyRows: string[][]): TableData => {
  const columns: TableColumn[] = header.map((label, index) => ({ label, type: columnTypeOfCells(bodyRows.map((row) => row[index] ?? "")) }));
  const rows = bodyRows.map((row) => {
    const cells = columns.map((_, index) => row[index] ?? "");
    return { cells, sortValues: cells.map((cell, index) => sortValueOf(cell, columns[index].type)) };
  });
  return { columns, rows };
};

const compareValues = (left: SortValue, right: SortValue): number => {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true });
};

export const sortedRowIndexes = (table: TableData, column: number, direction: SortDirection): number[] => {
  const sign = direction === "asc" ? 1 : -1;
  return table.rows
    .map((row, index) => ({ index, value: row.sortValues[column] }))
    .sort((left, right) => {
      if (left.value === undefined || right.value === undefined) return left.value === right.value ? left.index - right.index : left.value === undefined ? 1 : -1;
      return sign * compareValues(left.value, right.value) || left.index - right.index;
    })
    .map((entry) => entry.index);
};

export const matchingRowIndexes = (table: TableData, query: string): number[] => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return table.rows.flatMap((row, index) => {
    const haystack = row.cells.join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term)) ? [index] : [];
  });
};

export const nextSort = (current: { column: number; direction: SortDirection } | undefined, column: number): { column: number; direction: SortDirection } | undefined => {
  if (!current || current.column !== column) return { column, direction: "asc" };
  return current.direction === "asc" ? { column, direction: "desc" } : undefined;
};

export const visibleRowIndexes = (table: TableData, query: string, sort: { column: number; direction: SortDirection } | undefined): number[] => {
  const matching = new Set(matchingRowIndexes(table, query));
  const ordered = sort ? sortedRowIndexes(table, sort.column, sort.direction) : table.rows.map((_, index) => index);
  return ordered.filter((index) => matching.has(index));
};

const quoteCell = (cell: string, delimiter: string): string => (cell.includes(delimiter) || /["\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

export const tableToDelimited = (table: TableData, rowIndexes: number[], delimiter: "\t" | ","): string => {
  const lines = [table.columns.map((column) => column.label), ...rowIndexes.map((index) => table.rows[index].cells)];
  return lines.map((line) => line.map((cell) => quoteCell(cell.replace(/\r?\n/g, " "), delimiter)).join(delimiter)).join("\n");
};

export const csvFileName = (title: string | undefined): string => {
  const slug = (title ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "table"}.csv`;
};

interface ColumnSpec {
  key?: string;
  label?: string;
  type?: ColumnType;
  currency?: string;
  digits?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const formatCell = (value: unknown, column: ColumnSpec): { text: string; sort: SortValue } => {
  if (value === null || value === undefined || value === "") return { text: "", sort: undefined };
  const type = column.type ?? "text";
  const digits = column.digits === undefined ? undefined : { minimumFractionDigits: column.digits, maximumFractionDigits: column.digits };
  const number = typeof value === "number" ? value : parseNumber(String(value));
  if (type === "number" && number !== undefined) return { text: new Intl.NumberFormat(undefined, digits).format(number), sort: number };
  if (type === "percent" && number !== undefined) return { text: new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1, ...digits }).format(number), sort: number };
  if (type === "currency" && number !== undefined) {
    try {
      return { text: new Intl.NumberFormat(undefined, { style: "currency", currency: column.currency ?? "USD", ...digits }).format(number), sort: number };
    } catch {
      return { text: String(value), sort: number };
    }
  }
  if (type === "date") {
    const time = typeof value === "number" ? value : parseDate(String(value));
    if (time !== undefined) return { text: String(value), sort: time };
  }
  return { text: String(value), sort: String(value).toLowerCase() };
};

const columnSpecsOf = (raw: unknown): ColumnSpec[] | string => {
  if (!Array.isArray(raw) || raw.length === 0) return "A table needs a non-empty \"columns\" list";
  if (raw.length > MAX_TABLE_COLUMNS) return `A table can have at most ${MAX_TABLE_COLUMNS} columns`;
  const specs: ColumnSpec[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") specs.push({ key: entry, label: entry });
    else if (isRecord(entry) && (typeof entry.key === "string" || typeof entry.label === "string")) {
      const type = entry.type === undefined ? "text" : entry.type;
      if (!COLUMN_TYPES.includes(type as ColumnType)) return `Unknown column type "${String(entry.type)}"`;
      specs.push({
        key: typeof entry.key === "string" ? entry.key : undefined,
        label: typeof entry.label === "string" ? entry.label : undefined,
        type: type as ColumnType,
        currency: typeof entry.currency === "string" ? entry.currency : undefined,
        digits: typeof entry.digits === "number" ? Math.max(0, Math.min(8, Math.floor(entry.digits))) : undefined,
      });
    } else return "Each column must be a name or an object with a \"key\" or \"label\"";
  }
  return specs;
};

const cellOfRow = (row: unknown, spec: ColumnSpec, index: number): unknown => {
  if (Array.isArray(row)) return row[index];
  if (isRecord(row)) return spec.key !== undefined ? row[spec.key] : spec.label !== undefined ? row[spec.label] : undefined;
  return undefined;
};

const initialSortOf = (raw: unknown, specs: ColumnSpec[]): TableData["initialSort"] => {
  if (!isRecord(raw)) return undefined;
  const column = specs.findIndex((spec, index) => raw.column === index || raw.column === spec.key || raw.column === spec.label);
  if (column < 0) return undefined;
  return { column, direction: raw.direction === "desc" ? "desc" : "asc" };
};

export const parseTableSpec = (text: string): TableParse => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `The table is not valid JSON: ${(error as Error).message}` };
  }
  if (!isRecord(raw)) return { error: "A table must be a JSON object with \"columns\" and \"rows\"" };
  const specs = columnSpecsOf(raw.columns);
  if (typeof specs === "string") return { error: specs };
  if (!Array.isArray(raw.rows)) return { error: "A table needs a \"rows\" list" };
  if (raw.rows.length > MAX_TABLE_ROWS) return { error: `A table can have at most ${MAX_TABLE_ROWS} rows` };
  const columns: TableColumn[] = specs.map((spec) => ({ label: spec.label ?? spec.key ?? "", type: spec.type ?? "text" }));
  const rows = raw.rows.map((row) => {
    const formatted = specs.map((spec, index) => formatCell(cellOfRow(row, spec, index), spec));
    return { cells: formatted.map((cell) => cell.text), sortValues: formatted.map((cell) => cell.sort) };
  });
  return { table: { title: typeof raw.title === "string" ? raw.title : undefined, columns, rows, initialSort: initialSortOf(raw.sort, specs) } };
};
