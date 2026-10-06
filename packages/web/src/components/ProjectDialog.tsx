import { useState } from "react";
import { pickFolder } from "../api";
import { useBoard } from "../store";

export const ProjectDialog = ({ onClose }: { onClose: () => void }) => {
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [mode, setMode] = useState("claude");
  const isDemoShown = new URLSearchParams(location.search).has("demo");
  const [isBrowsing, setIsBrowsing] = useState(false);
  const browse = async () => {
    setIsBrowsing(true);
    try {
      const picked = await pickFolder();
      if (picked) setWorkspacePath(picked);
    } catch (error) {
      useBoard.getState().notify(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBrowsing(false);
    }
  };
  const connect = async () => {
    const { send, loadBoards, openBoard } = useBoard.getState();
    const project = await send<{ id: string }>({ type: "createProject", name: name.trim() || undefined, workspacePath, mode });
    if (!project) return;
    const board = await send<{ id: string }>({ type: "createBoard", projectId: project.id });
    await loadBoards();
    if (board) await openBoard(board.id);
    onClose();
  };
  return (
    <div className="dialog-backdrop">
      <div className="dialog">
        <h3>Connect a project</h3>
        <div className="muted">A project is a folder. You can create any number of boards for it afterwards.</div>
        <div className="field">
          <label htmlFor="workspace-folder">Folder</label>
          <div className="row">
            <input id="workspace-folder" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="C:\projects\my-workspace" autoFocus />
            <button type="button" disabled={isBrowsing} onClick={() => void browse()}>{isBrowsing ? "Waiting for dialog…" : "Browse…"}</button>
          </div>
        </div>
        <label>Name (optional, defaults to the folder name)<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>
          Runtime
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="claude">Claude subscription (installed claude command)</option>
            <option value="opencode">OpenCode</option>
            {isDemoShown && <option value="fake">Built-in demo (echoes its context)</option>}
          </select>
        </label>
        {mode === "opencode" && <div className="muted">Opening a workspace lets OpenCode run its configured tools and shell commands there. Only open workspaces you trust.</div>}
        {mode === "claude" && (
          <div className="muted">
            Runs the claude command already installed on this machine, in the workspace, signed in the way you set it up yourself. Branchboard never handles sign-in or credentials. Tool calls and questions are asked on the board. Only open workspaces you trust. Your use is subject to Anthropic's{" "}
            <a href="https://code.claude.com/docs/en/legal-and-compliance" target="_blank" rel="noreferrer">legal and compliance terms</a>.
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={!workspacePath.trim()} onClick={() => void connect()}>Connect</button>
        </div>
      </div>
    </div>
  );
};
