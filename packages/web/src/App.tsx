import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { handleShortcut } from "./actions";
import { BoardBar } from "./components/BoardBar";
import { Canvas } from "./components/Canvas";
import { ImagePreviewLayer } from "./components/ImagePreview";
import { ModifierHints } from "./components/ModifierHints";
import { RunsOverlay } from "./components/RunsOverlay";
import { SelectionMenu } from "./components/SelectionMenu";
import { ContextPanel } from "./components/ContextPanel";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { ReaderPanel } from "./components/ReaderPanel";
import { startPerfMonitor } from "./perfMonitor";
import { resolveTheme, useSettings } from "./settings";
import { useBoard } from "./store";

const TOAST_MS = 4000;

const Toast = () => {
  const toast = useBoard((state) => state.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => useBoard.setState({ toast: undefined }), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  return toast ? <div className="toast" role="alert">{toast.message}</div> : null;
};

const loadInitialBoard = async () => {
  const store = useBoard.getState();
  await store.loadBoards();
  const boards = useBoard.getState().boards;
  const remembered = localStorage.getItem("branchboard.lastBoard");
  const first = boards.find((board) => board.id === remembered) ?? boards[0];
  if (first) await store.openBoard(first.id);
};

export const App = () => {
  const board = useBoard((state) => state.board);
  useEffect(() => {
    void loadInitialBoard();
    const stopPolling = useBoard.getState().startRunPolling();
    const stopPerfMonitor = startPerfMonitor();
    const onKeyDown = (event: KeyboardEvent) => void handleShortcut(event);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      stopPolling();
      stopPerfMonitor();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  const isSidebarOpen = useSettings((state) => state.settings.isSidebarOpen);
  const navigation = useSettings((state) => state.settings.boardNavigation);
  const isContextPanelOpen = useSettings((state) => state.settings.isContextPanelOpen);
  const answerFont = useSettings((state) => state.settings.answerFont);
  useEffect(() => {
    document.documentElement.dataset.answerFont = answerFont;
  }, [answerFont]);
  const theme = useSettings((state) => state.settings.theme);
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme);
    };
    apply();
    if (theme !== "system") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [theme]);
  const isReaderOpen = useBoard((state) => state.isReaderOpen);
  return (
    <div className="app">
      <BoardBar />
      <div className="workspace">
        {isSidebarOpen && navigation !== "tabs" && <Sidebar />}
        {board ? (
          <>
            <main className="canvas-area">
              <ReactFlowProvider>
                <Canvas key={board.id} />
              </ReactFlowProvider>
              <SelectionMenu />
              <ModifierHints />
              <RunsOverlay />
            </main>
            {isReaderOpen && <ReaderPanel />}
            {isContextPanelOpen && <ContextPanel />}
          </>
        ) : (
          <div className="empty-state">Connect a project and create a board to start.</div>
        )}
      </div>
      {board && <Toolbar />}
      <Toast />
      <ImagePreviewLayer />
    </div>
  );
};
