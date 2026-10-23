import { useEffect, useState } from "react";
import { browseFolder, type BrowsedFolder } from "../api";
import { listenForEscape } from "../escape";

const joinPath = (folder: string, name: string) => `${folder}${/[\\/]$/.test(folder) ? "" : folder.includes("\\") ? "\\" : "/"}${name}`;

export const PathBrowser = ({ kind, start, onPick, onClose }: { kind: "folder" | "file"; start?: string; onPick: (path: string) => void; onClose: () => void }) => {
  const [folder, setFolder] = useState<BrowsedFolder>();
  const [location, setLocation] = useState(start);
  const [error, setError] = useState("");
  const [typedPath, setTypedPath] = useState<string>();
  useEffect(() => listenForEscape(onClose), [onClose]);
  useEffect(() => {
    let isStale = false;
    browseFolder(location, kind === "file").then(
      (loaded) => {
        if (isStale) return;
        setFolder(loaded);
        setTypedPath(undefined);
        setError("");
      },
      (failure) => !isStale && setError(failure instanceof Error ? failure.message : String(failure)),
    );
    return () => {
      isStale = true;
    };
  }, [location, kind]);
  return (
    <div className="dialog-backdrop">
      <div className="dialog path-browser" role="dialog" aria-modal="true" aria-label={kind === "folder" ? "Choose a folder" : "Choose a file"}>
        <h3>{kind === "folder" ? "Choose a folder" : "Choose a file"}</h3>
        <div className="row">
          <button type="button" disabled={!folder?.parent} onClick={() => folder?.parent && setLocation(folder.parent)} title="Up one folder">↑</button>
          <input aria-label="Path" value={typedPath ?? folder?.path ?? location ?? ""} spellCheck={false} onChange={(event) => setTypedPath(event.target.value)} onKeyDown={(event) => event.key === "Enter" && setLocation(event.currentTarget.value)} />
        </div>
        {error && <div className="part-error">{error}</div>}
        <div className="file-picker-list path-browser-list">
          {folder?.entries.map((entry) => (
            <button key={entry.name} onClick={() => (entry.isFolder ? setLocation(joinPath(folder.path, entry.name)) : onPick(joinPath(folder.path, entry.name)))}>
              {entry.isFolder ? `${entry.name}/` : entry.name}
            </button>
          ))}
          {folder?.entries.length === 0 && <span className="muted">Nothing here</span>}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          {kind === "folder" && <button className="primary" disabled={!folder} onClick={() => folder && onPick(folder.path)}>Use this folder</button>}
        </div>
      </div>
    </div>
  );
};
