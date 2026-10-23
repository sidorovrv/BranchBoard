import { useEffect, useState } from "react";
import { formatAgo, isApiRuntime } from "@branchboard/core";
import { actionById, titleWithShortcut } from "../actions";
import { fetchCatalog } from "../api";
import { useSettings } from "../settings";
import { sendBoardCommand, useBoard } from "../store";
import { BoardTabs } from "./BoardTabs";
import { HelpButton } from "./HelpMenu";
import { IconRow } from "../kit/Icons";
import { CostMeter, LimitsMeter } from "./LimitsMeter";
import { SettingsDialog } from "./SettingsDialog";
import { TrashDialog } from "./TrashDialog";
import { UpdateBanner } from "./UpdateBanner";

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
      <button disabled={isSaving} onClick={() => void saveNow()} title="Save now" aria-label="Save now"><IconRow names={["save"]} /></button>
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
  const isTourOpen = useBoard((state) => state.isTourOpen);
  useRuntimeHealth(isTourOpen ? undefined : board?.id);
  const meters = useBoard((state) => state.catalog?.meters) ?? [];
  const showMeters = useSettings((state) => state.settings.showTopbarMeters);
  const isSidebarOpen = useSettings((state) => state.settings.isSidebarOpen);
  const isContextPanelOpen = useSettings((state) => state.settings.isContextPanelOpen);
  const keybinds = useSettings((state) => state.settings.keybinds);
  const updateSetting = useSettings((state) => state.update);
  const isSettingsOpen = useBoard((state) => state.isSettingsOpen);
  const setSettingsOpen = useBoard((state) => state.setSettingsOpen);
  const [isTrashOpen, setIsTrashOpen] = useState(false);
  const isReaderOpen = useBoard((state) => state.isReaderOpen);

  return (
    <header className="board-bar">
      <button
        onClick={() => updateSetting("isSidebarOpen", !isSidebarOpen)}
        title={isSidebarOpen ? "Hide projects and boards" : "Show projects and boards"}
        aria-label={isSidebarOpen ? "Hide projects and boards" : "Show projects and boards"}
        aria-pressed={isSidebarOpen}
      >
        <IconRow names={[isSidebarOpen ? "sidebarClose" : "sidebarOpen"]} />
      </button>
      <BoardTabs />
      <span className="spacer" />
      <UpdateBanner />
      {board && (
        <>
          {showMeters && meters.length > 0 && (
            <>
              {meters.includes("cost") && <CostMeter />}
              {meters.includes("limits") && <LimitsMeter runtime={board.mode} />}
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
      <button onClick={() => setIsTrashOpen(true)} title="Trash" aria-label="Trash"><IconRow names={["delete"]} /></button>
      <span className="bar-divider" />
      <HelpButton />
      <button onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><IconRow names={["settings"]} /></button>
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
        title={isContextPanelOpen ? "Hide the side panel" : "Show the side panel"}
        aria-label={isContextPanelOpen ? "Hide the side panel" : "Show the side panel"}
        aria-pressed={isContextPanelOpen}
      >
        <IconRow names={[isContextPanelOpen ? "contextPanelClose" : "contextPanelOpen"]} />
      </button>
      {isSettingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {isTrashOpen && <TrashDialog onClose={() => setIsTrashOpen(false)} />}
    </header>
  );
};
