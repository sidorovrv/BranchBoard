import type { DiffRow, LineChange } from "@branchboard/core";

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
