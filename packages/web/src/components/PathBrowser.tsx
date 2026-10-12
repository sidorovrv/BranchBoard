import { useEffect, useState } from "react";
import { browseFolder, type BrowsedFolder } from "../api";

const joinPath = (folder: string, name: string) => `${folder}${/[\\/]$/.test(folder) ? "" : folder.includes("\\") ? "\\" : "/"}${name}`;

export const PathBrowser = ({ kind, start, onPick, onClose }: { kind: "folder" | "file"; start?: string; onPick: (path: string) => void; onClose: () => void }) => {
  const [folder, setFolder] = useState<BrowsedFolder>();
  const [location, setLocation] = useState(start);
  const [error, setError] = useState("");
  useEffect(() => {
    browseFolder(location, kind === "file").then(
      (loaded) => {
        setFolder(loaded);
        setError("");
      },
      (failure) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [location, kind]);
  return (
    <div className="dialog-backdrop">
      <div className="dialog path-browser">
        <h3>{kind === "folder" ? "Choose a folder" : "Choose a file"}</h3>
        <div className="row">
          <button type="button" disabled={!folder?.parent} onClick={() => folder?.parent && setLocation(folder.parent)} title="Up one folder">↑</button>
          <input value={folder?.path ?? location ?? ""} spellCheck={false} onChange={(event) => setFolder(folder && { ...folder, path: event.target.value })} onKeyDown={(event) => event.key === "Enter" && setLocation(event.currentTarget.value)} />
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
