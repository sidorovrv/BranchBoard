import { useState } from "react";
import { fileDisplayNames, totalChange, type DiffRow, type FileEdit, type LineChange } from "@branchboard/core";
import { ExtractFileButton } from "./CodeNode";
import { Icon } from "./Icons";

const VISIBLE_FILES = 3;

export const DiffStat = ({ change, isPill = false }: { change: LineChange; isPill?: boolean }) => (
  <span className={`diff-stat ${isPill ? "is-pill" : ""}`} title={`${change.added} lines added, ${change.removed} lines removed`}>
    <span className="diff-add">+{change.added}</span>
    <span className="diff-del">-{change.removed}</span>
  </span>
);

const ROW_MARKERS: Record<DiffRow["kind"], string> = { add: "+", remove: "-", same: "", gap: "" };

export const DiffView = ({ rows }: { rows: DiffRow[] }) => (
  <div className="diff-view copyable nodrag">
    {rows.map((row, index) => (
      <div key={index} className={`diff-row diff-row-${row.kind}`}>
        <span className="diff-marker">{ROW_MARKERS[row.kind]}</span>
        <span className="diff-text">{row.kind === "gap" ? "⋯" : row.text || " "}</span>
      </div>
    ))}
  </div>
);

const fileCountLabel = (count: number) => `Edited ${count} ${count === 1 ? "file" : "files"}`;

const EditFileRow = ({ edit, name }: { edit: FileEdit; name: string }) => (
  <details className="edits-file">
    <summary className="edits-row" title={edit.path}>
      <Icon name="code" />
      <span className="edits-label">{name}</span>
      <DiffStat change={edit} />
      <ExtractFileButton path={edit.path} />
      <Icon name="chevronRight" />
    </summary>
    <div className="edits-path">{edit.path}</div>
    <DiffView rows={edit.rows} />
  </details>
);

export const FileEditsSummary = ({ edits }: { edits: FileEdit[] }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  if (edits.length === 0) return null;
  const names = fileDisplayNames(edits.map((edit) => edit.path));
  const hiddenCount = edits.length - VISIBLE_FILES;
  const shown = isExpanded ? edits : edits.slice(0, VISIBLE_FILES);
  return (
    <div className="edits-summary">
      <div className="edits-row edits-head">
        <Icon name="edited" />
        <span className="edits-label">{fileCountLabel(edits.length)}</span>
        <DiffStat change={totalChange(edits)} />
      </div>
      {shown.map((edit, index) => (
        <EditFileRow key={edit.path} edit={edit} name={names[index]} />
      ))}
      {hiddenCount > 0 && (
        <button className={`edits-more nodrag ${isExpanded ? "is-open" : ""}`} onClick={() => setIsExpanded(!isExpanded)} aria-expanded={isExpanded}>
          <span className="edits-label">{isExpanded ? "Show less" : `Show ${hiddenCount} more`}</span>
          <Icon name="chevronRight" />
        </button>
      )}
    </div>
  );
};
