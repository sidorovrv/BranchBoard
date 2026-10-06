import { useMemo, useState, type ReactNode } from "react";
import { csvFileName, nextSort, parseTableSpec, tableToDelimited, visibleRowIndexes, type SortDirection, type TableData } from "@branchboard/core";
import { BlockError, BlockFrame } from "./BlockFrame";
import { CopyButton } from "./CodeFence";
import { Selectable } from "./Selectable";

const FILTER_MIN_ROWS = 8;
const NUMERIC_TYPES = ["number", "currency", "percent"];

interface DataTableProps {
  table: TableData;
  cellNodes?: ReactNode[][];
}

const EXCEL_UTF8_MARK = "﻿";

const downloadCsv = (fileName: string, csv: string) => {
  const url = URL.createObjectURL(new Blob([EXCEL_UTF8_MARK, csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

const arrowOf = (direction: SortDirection | undefined): string => (direction === "asc" ? "↑" : direction === "desc" ? "↓" : "");

export const DataTable = ({ table, cellNodes }: DataTableProps) => {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(table.initialSort);
  const rowIndexes = useMemo(() => visibleRowIndexes(table, query, sort), [table, query, sort]);
  const isNumeric = (column: number) => !cellNodes && NUMERIC_TYPES.includes(table.columns[column].type);
  const hasFilter = table.rows.length >= FILTER_MIN_ROWS;
  const isFiltered = query.trim() !== "";
  return (
    <div className="data-table">
      {(hasFilter || table.title) && (
        <div className="data-table-bar">
          {table.title && <span className="data-table-title">{table.title}</span>}
          {hasFilter && <input className="nodrag nowheel" value={query} placeholder="Filter rows" onChange={(event) => setQuery(event.target.value)} />}
          {isFiltered && <span className="data-table-count">{rowIndexes.length} of {table.rows.length}</span>}
        </div>
      )}
      <div className="data-table-scroll nodrag nowheel">
        <table>
          <thead>
            <tr>
              {table.columns.map((column, index) => (
                <th key={index} className={isNumeric(index) ? "is-numeric" : undefined} aria-sort={sort?.column === index ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}>
                  <button className="sort-header nodrag" onClick={() => setSort(nextSort(sort, index))}>
                    {column.label}
                    <span className="sort-arrow">{sort?.column === index ? arrowOf(sort.direction) : ""}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowIndexes.map((rowIndex) => (
              <tr key={rowIndex}>
                {cellNodes
                  ? cellNodes[rowIndex]
                  : table.rows[rowIndex].cells.map((cell, index) => (
                      <td key={index} className={isNumeric(index) ? "is-numeric" : undefined}>
                        <Selectable>{cell}</Selectable>
                      </td>
                    ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="data-table-foot">
        <span>{table.rows.length} rows</span>
        <span className="rich-actions">
          <button className="nodrag" onClick={() => downloadCsv(csvFileName(table.title), tableToDelimited(table, rowIndexes, ","))}>Download as CSV</button>
          <CopyButton text={tableToDelimited(table, rowIndexes, ",")} label="Copy as CSV" />
        </span>
      </div>
    </div>
  );
};

export const TableBlock = ({ source }: { source: string }) => {
  const parsed = useMemo(() => parseTableSpec(source), [source]);
  return (
    <BlockFrame label="table" source={source} language="json">
      {"error" in parsed ? <BlockError message={parsed.error} /> : <DataTable table={parsed.table} />}
    </BlockFrame>
  );
};
