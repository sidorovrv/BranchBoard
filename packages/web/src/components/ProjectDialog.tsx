import { useState } from "react";
import { isApiRuntime, isRuntimeShown, RUNTIMES, type RuntimeId } from "@branchboard/core";
import { pickPath } from "../api";
import { PathBrowser } from "./PathBrowser";
import { useBoard } from "../store";
import { CredentialForm, SetupGuide, useRuntimeCatalog } from "./SetupGuide";

const RUNTIME_CHOICES = (["claude", "opencode", "anthropic", "openai"] as RuntimeId[]).filter(isRuntimeShown);

const RUNTIME_LABELS: Partial<Record<RuntimeId, string>> = {
  claude: "Claude subscription (installed claude command)",
  fake: "Built-in demo (echoes its context)",
  anthropic: "Anthropic API (your own API key, chat only)",
  openai: "OpenAI-compatible API (OpenAI, OpenRouter, Ollama, LM Studio…)",
};

export const ProjectDialog = ({ onClose }: { onClose: () => void }) => {
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [mode, setMode] = useState<RuntimeId>("claude");
  const [modelId, setModelId] = useState("");
  const isDemoShown = new URLSearchParams(location.search).has("demo");
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isBrowserShown, setIsBrowserShown] = useState(false);
  const { catalog, refresh } = useRuntimeCatalog(mode);
  const browse = async () => {
    setIsBrowsing(true);
    try {
      const picked = await pickPath("folder");
      if (picked) setWorkspacePath(picked);
    } catch {
      setIsBrowserShown(true);
    } finally {
      setIsBrowsing(false);
    }
  };
  const connect = async () => {
    const { send, loadBoards, openBoard } = useBoard.getState();
    const project = await send<{ id: string }>({ type: "createProject", name: name.trim() || undefined, workspacePath, mode, defaultModel: modelId.trim() || undefined });
    if (!project) return;
    const board = await send<{ id: string }>({ type: "createBoard", projectId: project.id });
    await loadBoards();
    if (board) await openBoard(board.id);
    onClose();
  };
  const choices = isDemoShown ? [...RUNTIME_CHOICES, "fake" as RuntimeId] : RUNTIME_CHOICES;
  const isBlocked = catalog !== undefined && !catalog.health.ok;
  return (
    <div className="dialog-backdrop">
      {isBrowserShown && <PathBrowser kind="folder" start={workspacePath.trim() || undefined} onPick={(path) => { setWorkspacePath(path); setIsBrowserShown(false); }} onClose={() => setIsBrowserShown(false)} />}
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
          <select value={mode} onChange={(event) => setMode(event.target.value as RuntimeId)}>
            {choices.map((id) => <option key={id} value={id}>{RUNTIME_LABELS[id] ?? RUNTIMES[id].label}</option>)}
          </select>
        </label>
        {(mode === "opencode" || mode === "opencode2") && <div className="muted">Opening a workspace lets OpenCode run its configured tools and shell commands there. Only open workspaces you trust.</div>}
        {mode === "claude" && (
          <div className="muted">
            Runs the claude command already installed on this machine, in the workspace, signed in the way you set it up yourself. Branchboard never handles sign-in or credentials for it. Tool calls and questions are asked on the board. Only open workspaces you trust. Your use is subject to Anthropic's{" "}
            <a href="https://code.claude.com/docs/en/legal-and-compliance" target="_blank" rel="noreferrer">legal and compliance terms</a>.
          </div>
        )}
        {isApiRuntime(mode) && (
          <>
            <div className="muted">Talks to the provider directly with your own key: chat only, no tools and no file access (images are sent). The key is saved on this computer, in the Branchboard data folder, and cannot be read back through the app.</div>
            <CredentialForm runtimeId={mode} status={catalog?.credential} onChanged={() => void refresh(true)} />
            {mode === "openai" && (
              <label>
                Model id (optional, when the server cannot list its models)
                <input value={modelId} spellCheck={false} onChange={(event) => setModelId(event.target.value)} placeholder="gpt-4o-mini" />
              </label>
            )}
          </>
        )}
        {isBlocked && !isApiRuntime(mode) && (
          <div className="setup-block">
            <div className="part-error">{catalog.health.detail}</div>
            <SetupGuide runtimeId={mode} catalog={catalog} onCheckAgain={() => void refresh(true)} />
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={!workspacePath.trim() || isBlocked} title={isBlocked ? catalog.health.detail : undefined} onClick={() => void connect()}>Connect</button>
        </div>
      </div>
    </div>
  );
};
