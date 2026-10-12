import { useState } from "react";
import { fileDisplayNames, isInFlight, totalChange, type FileEdit, type GraphNode } from "@branchboard/core";
import { ExtractFileButton } from "./CodeNode";
import { DiffStat, DiffView } from "./DiffView";
import { Icon } from "./Icons";
import { RevertDialog } from "./RevertDialog";

export { DiffStat, DiffView };

const VISIBLE_FILES = 3;

const fileCountLabel = (count: number) => `Edited ${count} ${count === 1 ? "file" : "files"}`;

interface RevertRequest {
  redo: boolean;
  onlyEditPath?: string;
}

const EditFileRow = ({ edit, name, onRevert }: { edit: FileEdit; name: string; onRevert?: () => void }) => (
  <details className="edits-file">
    <summary className="edits-row" title={edit.path}>
      <Icon name="code" />
      <span className="edits-label">{name}</span>
      <DiffStat change={edit} />
      <ExtractFileButton path={edit.path} />
      <Icon name="chevronRight" />
    </summary>
    <div className="edits-path">
      <span className="edits-label">{edit.path}</span>
      {onRevert && <button className="edits-revert nodrag" onClick={onRevert} title={`Revert ${name}`}>Revert</button>}
    </div>
    <DiffView rows={edit.rows} />
  </details>
);

export const FileEditsSummary = ({ edits, node }: { edits: FileEdit[]; node?: GraphNode }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [request, setRequest] = useState<RevertRequest>();
  if (edits.length === 0) return null;
  const names = fileDisplayNames(edits.map((edit) => edit.path));
  const hiddenCount = edits.length - VISIBLE_FILES;
  const shown = isExpanded ? edits : edits.slice(0, VISIBLE_FILES);
  const canRevert = node !== undefined && node.kind === "turn" && !isInFlight(node) && node.fileHashes != null;
  const hasReverted = (node?.reverted?.files.length ?? 0) > 0;
  return (
    <div className="edits-summary">
      <div className="edits-row edits-head">
        <Icon name="edited" />
        <span className="edits-label">{fileCountLabel(edits.length)}</span>
        <DiffStat change={totalChange(edits)} />
        {canRevert && (
          <button className={`edits-toggle nodrag ${isMenuOpen ? "is-open" : ""}`} onClick={() => setIsMenuOpen(!isMenuOpen)} aria-expanded={isMenuOpen} title="Revert options" aria-label="Revert options">
            <Icon name="chevronRight" />
          </button>
        )}
      </div>
      {canRevert && isMenuOpen && (
        <div className="edits-row edits-actions">
          <button className="edits-revert nodrag" onClick={() => setRequest({ redo: false })}>Revert all</button>
          {hasReverted && <button className="edits-revert nodrag" onClick={() => setRequest({ redo: true })}>Redo revert</button>}
        </div>
      )}
      {shown.map((edit, index) => (
        <EditFileRow key={edit.path} edit={edit} name={names[index]} onRevert={canRevert ? () => setRequest({ redo: false, onlyEditPath: edit.path }) : undefined} />
      ))}
      {hiddenCount > 0 && (
        <button className={`edits-more nodrag ${isExpanded ? "is-open" : ""}`} onClick={() => setIsExpanded(!isExpanded)} aria-expanded={isExpanded}>
          <span className="edits-label">{isExpanded ? "Show less" : `Show ${hiddenCount} more`}</span>
          <Icon name="chevronRight" />
        </button>
      )}
      {request && node && <RevertDialog node={node} redo={request.redo} onlyEditPath={request.onlyEditPath} onClose={() => setRequest(undefined)} />}
    </div>
  );
};
