import { useEffect, useState } from "react";
import { DEFAULT_BOARD_TITLE, type Board } from "@branchboard/core";
import { useSidebarLayout } from "../sidebarLayout";
import { useBoard } from "../store";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { IconRow } from "./Icons";
import { ProjectDialog } from "./ProjectDialog";
import { ACTIVITY_TITLES, activityOf, createBoardIn, deleteBoard, EditableName, exportBoard, importBoard, sendWorkspaceCommand } from "./Sidebar";

const MAX_CLOSED_BOARDS_LISTED = 12;

const BoardTab = ({ board, isActive, canClose }: { board: Board; isActive: boolean; canClose: boolean }) => {
  const runs = useBoard((state) => state.runs);
  const activeId = useBoard((state) => state.board?.id);
  const projectName = useBoard((state) => state.projects.find((project) => project.id === board.projectId)?.name);
  const openTabIds = useSidebarLayout((state) => state.openTabIds);
  const [isRenaming, setIsRenaming] = useState(false);
  const { open, element } = useContextMenu();
  const activity = activityOf(board, runs, activeId);
  const close = async () => {
    if (isActive) {
      const index = openTabIds.indexOf(board.id);
      const neighbour = openTabIds[index + 1] ?? openTabIds[index - 1];
      if (neighbour) await useBoard.getState().openBoard(neighbour);
    }
    useSidebarLayout.getState().closeTab(board.id);
  };
  const menu: MenuItem[] = [
    { label: "Rename", run: () => setIsRenaming(true) },
    { label: "Export board", run: () => exportBoard(board) },
    { label: "Import board…", run: () => void importBoard(board.projectId ?? "") },
    ...(canClose ? [{ label: "Close tab", run: () => void close() }] : []),
    { label: "Delete board", isDanger: true, run: () => void deleteBoard(board) },
  ];
  return (
    <li className={`board-tab ${isActive ? "active" : ""}`} onContextMenu={open(menu)} title={[projectName, board.title].filter(Boolean).join(" / ")}>
      <button className="board-tab-open" onClick={() => void useBoard.getState().openBoard(board.id)} onDoubleClick={() => setIsRenaming(true)}>
        <EditableName
          className={`sidebar-board-title ${board.title === DEFAULT_BOARD_TITLE ? "is-untitled" : ""}`}
          value={board.title}
          isEditing={isRenaming}
          onEditingChange={setIsRenaming}
          onCommit={(title) => void sendWorkspaceCommand({ type: "updateBoard", boardId: board.id, title }).then(() => useBoard.getState().loadBoards())}
        />
        {activity !== "none" && <span className={`board-dot is-${activity}`} title={ACTIVITY_TITLES[activity]} aria-label={ACTIVITY_TITLES[activity]} />}
      </button>
      {canClose && <button className="board-tab-close" onClick={() => void close()} title="Close tab" aria-label={`Close ${board.title}`}>×</button>}
      {element}
    </li>
  );
};

const NewTabButton = ({ onAddProject }: { onAddProject: () => void }) => {
  const projects = useBoard((state) => state.projects);
  const boards = useBoard((state) => state.boards);
  const openTabIds = useSidebarLayout((state) => state.openTabIds);
  const { open, element } = useContextMenu();
  const closedBoards = boards.filter((board) => !openTabIds.includes(board.id)).slice(0, MAX_CLOSED_BOARDS_LISTED);
  const nameOfProject = (board: Board) => projects.find((project) => project.id === board.projectId)?.name;
  const items: MenuItem[] = [
    ...projects.map((project) => ({ label: `New board in ${project.name}`, run: () => void createBoardIn(project.id) })),
    ...closedBoards.map((board) => ({ label: `Open ${[nameOfProject(board), board.title].filter(Boolean).join(" / ")}`, run: () => void useBoard.getState().openBoard(board.id) })),
    { label: "Add project…", run: onAddProject },
  ];
  return (
    <>
      <button className="board-tab-add" onClick={open(items)} title="New board, open a board or add a project" aria-label="New board, open a board or add a project"><IconRow names={["add"]} /></button>
      {element}
    </>
  );
};

export const BoardTabs = () => {
  const boards = useBoard((state) => state.boards);
  const activeId = useBoard((state) => state.board?.id);
  const openTabIds = useSidebarLayout((state) => state.openTabIds);
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  useEffect(() => {
    if (activeId) useSidebarLayout.getState().openTab(activeId);
  }, [activeId]);
  const tabs = openTabIds.flatMap((id) => boards.find((board) => board.id === id) ?? []);
  return (
    <nav className="board-tabs" aria-label="Boards">
      <ul>{tabs.map((board) => <BoardTab key={board.id} board={board} isActive={board.id === activeId} canClose={tabs.length > 1} />)}</ul>
      <NewTabButton onAddProject={() => setIsProjectDialogOpen(true)} />
      {isProjectDialogOpen && <ProjectDialog onClose={() => setIsProjectDialogOpen(false)} />}
    </nav>
  );
};
