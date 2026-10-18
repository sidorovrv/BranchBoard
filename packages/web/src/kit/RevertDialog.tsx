import { useEffect, useMemo, useState } from "react";
import type { DiffRow } from "@branchboard/core";
import { DiffView } from "./DiffView";

export interface PreviewFile {
  path: string;
  origin: "snapshot" | "inverse" | "redo";
  conflict: boolean;
  unavailable?: string;
  rows: DiffRow[];
}

export interface RevertControl {
  id: string;
  hasReverted: boolean;
  preview: (isRedo: boolean) => Promise<PreviewFile[] | undefined>;
  apply: (isRedo: boolean, paths: string[], isForced: boolean) => Promise<boolean>;
}

const ORIGIN_NOTES: Record<PreviewFile["origin"], string> = {
  snapshot: "from the copy taken when the run started",
  inverse: "by undoing the recorded edits",
  redo: "from the version saved when you reverted",
};

export const matchesEditPath = (editPath: string, filePath: string): boolean => {
  const normalised = editPath.replace(/\\/g, "/");
  return normalised === filePath || normalised.endsWith(`/${filePath}`);
};

export const RevertDialog = ({ revert, redo, onlyEditPath, onClose }: { revert: RevertControl; redo: boolean; onlyEditPath?: string; onClose: () => void }) => {
  const [files, setFiles] = useState<PreviewFile[]>();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [isWorking, setIsWorking] = useState(false);
  useEffect(() => {
    let isCurrent = true;
    void revert.preview(redo).then((previewFiles) => {
      if (!isCurrent || !previewFiles) return;
      setFiles(previewFiles);
      setChosen(new Set(previewFiles.filter((file) => !file.unavailable && !file.conflict && (!onlyEditPath || matchesEditPath(onlyEditPath, file.path))).map((file) => file.path)));
    });
    return () => {
      isCurrent = false;
    };
  }, [revert.id, redo, onlyEditPath]);
  const hasChosenConflict = useMemo(() => (files ?? []).some((file) => chosen.has(file.path) && file.conflict), [files, chosen]);
  const toggle = (path: string) => setChosen((current) => new Set(current.has(path) ? [...current].filter((entry) => entry !== path) : [...current, path]));
  const choose = (isIncluded: (file: PreviewFile) => boolean) => setChosen(new Set((files ?? []).filter(isIncluded).map((file) => file.path)));
  const selectedLabel = `${chosen.size} of ${files?.length ?? 0} selected`;
  const apply = async () => {
    const count = `${chosen.size} ${chosen.size === 1 ? "file" : "files"}`;
    if (!confirm(`${redo ? "Redo the agent's edits in" : "Revert"} ${count}? This overwrites the files in your workspace.`)) return;
    setIsWorking(true);
    const isApplied = await revert.apply(redo, [...chosen], hasChosenConflict);
    setIsWorking(false);
    if (isApplied) onClose();
  };
  return (
    <div className="dialog-backdrop">
      <div className="dialog revert-dialog">
        <h3>{redo ? "Redo the agent's edits" : "Revert the agent's edits"}</h3>
        {!files && <div className="muted">Checking the files…</div>}
        {files?.length === 0 && <div className="muted">There are no files to {redo ? "restore" : "revert"}.</div>}
        {files && files.length > 0 && (
          <div className="revert-toolbar">
            <div className="revert-select">
              <button onClick={() => choose((file) => !file.unavailable)}>All</button>
              <button onClick={() => choose(() => false)}>None</button>
              <button onClick={() => choose((file) => !file.unavailable && !file.conflict)} title="Every file this prompt edited, except those you changed since">This prompt</button>
            </div>
            <span className="muted">{selectedLabel}</span>
          </div>
        )}
        <div className="revert-files">
          {files?.map((file) => (
            <section key={file.path} className={`revert-file ${chosen.has(file.path) ? "is-chosen" : ""}`}>
              <header>
                <label className="inline-check">
                  <input type="checkbox" disabled={Boolean(file.unavailable)} checked={chosen.has(file.path)} onChange={() => toggle(file.path)} />
                  <strong>{file.path}</strong>
                </label>
                {file.conflict && <span className="health bad">changed since the run</span>}
              </header>
              {file.unavailable ? <div className="part-error">{file.unavailable}</div> : <div className="muted">{redo ? "Restores" : "Brings back"} the version {ORIGIN_NOTES[file.origin]}.</div>}
              {file.conflict && <div className="muted">Ticking it overwrites your later changes.</div>}
              {!file.unavailable && <DiffView rows={file.rows} />}
            </section>
          ))}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={chosen.size === 0 || isWorking} onClick={() => void apply()}>
            {redo ? "Redo" : "Revert"} {chosen.size} {chosen.size === 1 ? "file" : "files"}
          </button>
        </div>
      </div>
    </div>
  );
};
