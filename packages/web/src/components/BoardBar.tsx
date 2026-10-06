import { useEffect, useState } from "react";
import { formatAgo } from "@branchboard/core";
import { actionById, titleWithShortcut } from "../actions";
import { fetchCatalog } from "../api";
import { useSettings } from "../settings";
import { sendBoardCommand, useBoard } from "../store";
import { BoardTabs } from "./BoardTabs";
import { HealthDialog } from "./HealthDialog";
import { IconRow } from "./Icons";
import { CostMeter, LimitsMeter } from "./LimitsMeter";
import { SettingsDialog } from "./SettingsDialog";

const SAVED_REFRESH_MS = 15000;

const SavedStatus = () => {
  const savedAt = useBoard((state) => state.view.savedAt);
  const [currentTime, setCurrentTime] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), SAVED_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const [isSaving, setIsSaving] = useState(false);
  const saveNow = async () => {
    setIsSaving(true);
    try {
      await sendBoardCommand({ type: "saveNow" });
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <span className="saved-status">
      <span className="muted">Saved {formatAgo(Math.max(0, currentTime - savedAt))}</span>
      <button disabled={isSaving} onClick={() => void saveNow()} title="Save now: write everything to disk again" aria-label="Save now"><IconRow names={["save"]} /></button>
    </span>
  );
};

const HEALTH_REFRESH_MS = 15000;

const useRuntimeHealth = (boardId: string | undefined) => {
  const [health, setHealth] = useState<{ ok: boolean; detail: string }>();
  useEffect(() => {
    setHealth(undefined);
    if (!boardId) return;
    let isCurrent = true;
    const refresh = () =>
      fetchCatalog(boardId).then(
        (catalog) => {
          if (!isCurrent) return;
          setHealth(catalog.health);
          useBoard.setState({ catalog });
        },
        () => isCurrent && setHealth({ ok: false, detail: "The runtime did not answer" }),
      );
    void refresh();
    const timer = setInterval(refresh, HEALTH_REFRESH_MS);
    return () => {
      isCurrent = false;
      clearInterval(timer);
    };
  }, [boardId]);
  return health;
};

export const BoardBar = () => {
  const board = useBoard((state) => state.board);
  const project = useBoard((state) => state.projects.find((candidate) => candidate.id === state.board?.projectId));
  useRuntimeHealth(board?.id);
  const showMeters = useSettings((state) => state.settings.showTopbarMeters);
  const isSidebarOpen = useSettings((state) => state.settings.isSidebarOpen);
  const isContextPanelOpen = useSettings((state) => state.settings.isContextPanelOpen);
  const keybinds = useSettings((state) => state.settings.keybinds);
  const updateSetting = useSettings((state) => state.update);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHealthOpen, setIsHealthOpen] = useState(false);
  const isReaderOpen = useBoard((state) => state.isReaderOpen);

  const navigation = useSettings((state) => state.settings.boardNavigation);
  const hasSidebar = navigation !== "tabs";
  const hasTabs = navigation !== "sidebar";

  return (
    <header className="board-bar">
      {hasSidebar && (
        <button
          onClick={() => updateSetting("isSidebarOpen", !isSidebarOpen)}
          title={isSidebarOpen ? "Hide projects and boards" : "Show projects and boards"}
          aria-label={isSidebarOpen ? "Hide projects and boards" : "Show projects and boards"}
          aria-pressed={isSidebarOpen}
        >
          <IconRow names={[isSidebarOpen ? "sidebarClose" : "sidebarOpen"]} />
        </button>
      )}
      {hasTabs && <BoardTabs />}
      {board && !hasTabs && (
        <span className="board-crumb">
          {project && <span className="crumb-project">{project.name}</span>}
          {project && <span className="crumb-separator">/</span>}
          <strong className="crumb-board">{board.title}</strong>
        </span>
      )}
      {!board && !hasTabs && <strong className="brand">Branchboard</strong>}
      <span className="spacer" />
      {board && (
        <>
          {showMeters && (
            <>
              {board.mode === "opencode" ? <CostMeter /> : <LimitsMeter />}
              <span className="bar-divider" />
            </>
          )}
          <SavedStatus />
          <span className="bar-divider" />
          {["undo", "redo"].map((id) => (
            <button key={id} onClick={() => void actionById(id).run({})} title={titleWithShortcut(id, keybinds)} aria-label={actionById(id).label({})}>
              <IconRow names={actionById(id).icons({})} />
            </button>
          ))}
        </>
      )}
      <span className="bar-divider" />
      <button onClick={() => setIsHealthOpen(true)} title="Runtime health and logs" aria-label="Runtime health and logs"><IconRow names={["health"]} /></button>
      <button onClick={() => setIsSettingsOpen(true)} title="Settings" aria-label="Settings"><IconRow names={["settings"]} /></button>
      <button
        onClick={() => useBoard.getState().setReaderOpen(!isReaderOpen)}
        title={titleWithShortcut("reader", keybinds)}
        aria-label={actionById("reader").label({})}
        aria-pressed={isReaderOpen}
      >
        <IconRow names={["reader"]} />
      </button>
      <button
        onClick={() => updateSetting("isContextPanelOpen", !isContextPanelOpen)}
        title={isContextPanelOpen ? "Hide the context panel" : "Show the context panel"}
        aria-label={isContextPanelOpen ? "Hide the context panel" : "Show the context panel"}
        aria-pressed={isContextPanelOpen}
      >
        <IconRow names={[isContextPanelOpen ? "contextPanelClose" : "contextPanelOpen"]} />
      </button>
      {isSettingsOpen && <SettingsDialog onClose={() => setIsSettingsOpen(false)} />}
      {isHealthOpen && <HealthDialog onClose={() => setIsHealthOpen(false)} />}
    </header>
  );
};
