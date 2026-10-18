import { useState } from "react";
import { isApiRuntime, RUNTIMES, runtimeInfo, type RuntimeId } from "@branchboard/core";
import { pickPath } from "../api";
import { ChipSelect } from "../kit/ChipSelect";
import { PathBrowser } from "./PathBrowser";
import { useBoard } from "../store";
import { CliSetup, CredentialForm, setUpEngine, useRuntimeCatalog } from "./SetupGuide";

const RUNTIME_CHOICES = ["claude", "codex", "opencode", "anthropic", "openai"] as RuntimeId[];

const RUNTIME_LABELS: Partial<Record<RuntimeId, string>> = {
  claude: "Claude subscription (installed claude command)",
  codex: "ChatGPT subscription (installed codex command)",
  fake: "Built-in demo (echoes its context)",
  anthropic: "Anthropic API (your own API key)",
  openai: "OpenAI-compatible API (OpenAI, OpenRouter, Ollama, LM Studio…)",
};

export const ProjectDialog = ({ onClose }: { onClose: () => void }) => {
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [mode, setMode] = useState<RuntimeId>("claude");
  const [modelId, setModelId] = useState("");
  const isDemoShown = new URLSearchParams(location.search).has("demo");
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
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
    if (isApiRuntime(mode)) {
      setIsConnecting(true);
      const isEngineReady = await setUpEngine(mode, refresh);
      setIsConnecting(false);
      if (!isEngineReady) return;
    }
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
        <div className="muted">A project is a folder. Its boards share that folder.</div>
        <div className="field">
          <label htmlFor="workspace-folder">Folder</label>
          <div className="row">
            <input id="workspace-folder" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="C:\projects\my-workspace" autoFocus />
            <button type="button" disabled={isBrowsing} onClick={() => void browse()}>{isBrowsing ? "Waiting for dialog…" : "Browse…"}</button>
          </div>
        </div>
        <label>Name (optional)<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="field">
          <label>Runtime</label>
          <ChipSelect icon="model" title="Runtime" value={mode} options={choices.map((id) => ({ value: id, label: RUNTIME_LABELS[id] ?? RUNTIMES[id].label }))} onChange={(id) => setMode(id as RuntimeId)} />
        </div>
        {runtimeInfo(mode).trustNote && <div className="muted">{RUNTIMES[mode].label} can read and edit files and run commands in this folder. Only connect folders you trust.</div>}
        {mode === "claude" && (
          <div className="muted">
            Uses the installed claude command and its existing sign-in. Can read and edit files and run commands in this folder, so only connect folders you trust. Your use is subject to Anthropic's{" "}
            <a href="https://code.claude.com/docs/en/legal-and-compliance" target="_blank" rel="noreferrer">legal and compliance terms</a>.
          </div>
        )}
        {mode === "codex" && (
          <div className="muted">
            Uses the installed codex command and its codex login. Can read and edit files and run commands in this folder, so only connect folders you trust. Codex marks the folder as trusted in its own settings. See OpenAI's{" "}
            <a href="https://learn.chatgpt.com/docs/app-server" target="_blank" rel="noreferrer">Codex app-server terms</a>.
          </div>
        )}
        {isApiRuntime(mode) && (
          <>
            <div className="muted">Runs on the OpenCode 2 engine with your own key, saved in the Branchboard data folder.</div>
            <CredentialForm runtimeId={mode} catalog={catalog} refresh={refresh} isNoticeShown />
            {mode === "openai" && (
              <label>
                Model id (optional)
                <input value={modelId} spellCheck={false} onChange={(event) => setModelId(event.target.value)} placeholder="gpt-4o-mini" />
              </label>
            )}
          </>
        )}
        {isBlocked && !isApiRuntime(mode) && (
          <div className="setup-block">
            <div className="part-error">{catalog.health.detail}</div>
            <CliSetup runtimeId={mode} onCheckAgain={() => void refresh(true)} />
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={!workspacePath.trim() || isBlocked || isConnecting} title={isBlocked ? catalog.health.detail : undefined} onClick={() => void connect()}>{isConnecting ? "Downloading the engine…" : "Connect"}</button>
        </div>
      </div>
    </div>
  );
};
