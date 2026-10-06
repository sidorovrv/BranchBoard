import { useEffect, useState, type DragEvent } from "react";
import { applyOrder, DEFAULT_BOARD_TITLE, formatAgo, moveWithin, type Board, type ListPlacement, type Project, type RunInfo } from "@branchboard/core";
import { useSidebarLayout } from "../sidebarLayout";
import { useBoard } from "../store";
import { useContextMenu } from "./ContextMenu";
import { IconRow } from "./Icons";
import { ProjectDialog } from "./ProjectDialog";
import { TrashDialog } from "./TrashDialog";

export const sendWorkspaceCommand = <T = any,>(command: Record<string, unknown>) => useBoard.getState().send<T>(command);

export const createBoardIn = async (projectId: string) => {
  const created = await sendWorkspaceCommand<{ id: string }>({ type: "createBoard", projectId });
  if (!created) return;
  await useBoard.getState().loadBoards();
  await useBoard.getState().openBoard(created.id);
};

export const deleteBoard = async (board: Board) => {
  if (!confirm(`Move board “${board.title}” to the trash?`)) return;
  await sendWorkspaceCommand({ type: "deleteBoard", boardId: board.id });
  await useBoard.getState().loadBoards();
  const { board: current, boards, openBoard } = useBoard.getState();
  if (current?.id !== board.id) return;
  const next = boards[0];
  if (next) await openBoard(next.id);
  else useBoard.setState({ board: undefined });
};

const deleteProject = async (project: Project) => {
  if (!confirm(`Move project “${project.name}” and all of its boards to the trash? The folder itself is not touched.`)) return;
  await sendWorkspaceCommand({ type: "deleteProject", projectId: project.id });
  await useBoard.getState().loadBoards();
  const { board: current, boards, openBoard } = useBoard.getState();
  if (current && boards.some((candidate) => candidate.id === current.id)) return;
  if (boards[0]) await openBoard(boards[0].id);
  else useBoard.setState({ board: undefined });
};

export const exportBoard = (board: Board) => {
  const link = document.createElement("a");
  link.href = `/api/boards/${board.id}/export`;
  link.download = "";
  link.click();
};

const pickBoardFile = (): Promise<File | undefined> =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });

export const importBoard = async (projectId: string) => {
  const file = await pickBoardFile();
  if (!file) return;
  const imported = await sendWorkspaceCommand<{ id: string }>({ type: "importBoard", projectId, raw: await file.text() });
  if (!imported) return;
  await useBoard.getState().loadBoards();
  await useBoard.getState().openBoard(imported.id);
};

export const EditableName = ({ value, isEditing, onEditingChange, onCommit, className }: { value: string; isEditing: boolean; onEditingChange: (isEditing: boolean) => void; onCommit: (value: string) => void; className?: string }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (isEditing) setDraft(value);
  }, [isEditing, value]);
  const finish = () => {
    onEditingChange(false);
    if (draft.trim() && draft.trim() !== value) onCommit(draft.trim());
  };
  if (!isEditing) return <span className={className}>{value}</span>;
  return <input className="sidebar-rename" autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={finish} onKeyDown={(event) => (event.key === "Enter" && finish()) || (event.key === "Escape" && onEditingChange(false))} />;
};

export type BoardActivity = "attention" | "working" | "limit" | "unseen" | "none";

export const ACTIVITY_TITLES: Record<BoardActivity, string> = { attention: "A node is waiting for your answer", working: "Nodes are running or queued", limit: "A run hit the usage limit; regenerate it after the limit resets", unseen: "Finished since you last opened it", none: "" };

type DropPlacement = ListPlacement | undefined;

interface DragSource {
  kind: "project" | "board";
  scopeId: string;
  id: string;
}

let dragSource: DragSource | undefined;

const useReorderable = (kind: DragSource["kind"], scopeId: string, id: string, orderedIds: string[], onReorder: (ids: string[]) => void, isEnabled: boolean) => {
  const [placement, setPlacement] = useState<DropPlacement>();
  const accepts = () => dragSource?.kind === kind && dragSource.scopeId === scopeId && dragSource.id !== id;
  const placementOf = (event: DragEvent<HTMLElement>): ListPlacement => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
  };
  return {
    placement,
    props: {
      draggable: isEnabled,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        dragSource = { kind, scopeId, id };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
      },
      onDragEnd: () => {
        dragSource = undefined;
        setPlacement(undefined);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!accepts()) return;
        event.preventDefault();
        event.stopPropagation();
        setPlacement(placementOf(event));
      },
      onDragLeave: () => setPlacement(undefined),
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!accepts() || !dragSource) return;
        event.preventDefault();
        event.stopPropagation();
        onReorder(moveWithin(orderedIds, dragSource.id, id, placementOf(event)));
        dragSource = undefined;
        setPlacement(undefined);
      },
    },
  };
};

const BoardRow = ({ board, isActive, activity, orderedIds }: { board: Board; isActive: boolean; activity: BoardActivity; orderedIds: string[] }) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const { open, element } = useContextMenu();
  const setBoardOrder = useSidebarLayout((state) => state.setBoardOrder);
  const { placement, props } = useReorderable("board", board.projectId ?? "", board.id, orderedIds, (ids) => setBoardOrder(board.projectId ?? "", ids), !isRenaming);
  return (
    <li className={`sidebar-board ${isActive ? "active" : ""} ${placement ? `drop-${placement}` : ""}`} {...props} onContextMenu={open([
        { label: "Rename", run: () => setIsRenaming(true) },
        { label: "Export board", run: () => exportBoard(board) },
        { label: "Import board…", run: () => void importBoard(board.projectId ?? "") },
        { label: "Delete board", isDanger: true, run: () => void deleteBoard(board) },
      ])}>
      <button className="sidebar-board-open" onClick={() => void useBoard.getState().openBoard(board.id)} onDoubleClick={() => setIsRenaming(true)}>
        <span className={`board-dot is-${activity}`} title={ACTIVITY_TITLES[activity]} aria-label={ACTIVITY_TITLES[activity] || undefined} />
        <EditableName
          className={`sidebar-board-title ${board.title === DEFAULT_BOARD_TITLE ? "is-untitled" : ""}`}
          value={board.title}
          isEditing={isRenaming}
          onEditingChange={setIsRenaming}
          onCommit={(title) => void sendWorkspaceCommand({ type: "updateBoard", boardId: board.id, title }).then(() => useBoard.getState().loadBoards())}
        />
        <span className="muted">{formatAgo(Math.max(0, Date.now() - board.updatedAt))}</span>
      </button>
      {element}
    </li>
  );
};

export const activityOf = (board: Board, runs: RunInfo[], activeId?: string): BoardActivity => {
  const boardRuns = runs.filter((run) => run.boardId === board.id);
  if (boardRuns.some((run) => run.status === "awaiting_approval")) return "attention";
  if (boardRuns.length > 0) return "working";
  if (board.hitUsageLimit) return "limit";
  return board.hasUnseenResult && board.id !== activeId ? "unseen" : "none";
};

const ACTIVITY_PRIORITY: BoardActivity[] = ["attention", "working", "limit", "unseen", "none"];

const strongestActivity = (activities: BoardActivity[]): BoardActivity => ACTIVITY_PRIORITY.find((activity) => activities.includes(activity)) ?? "none";

const ProjectSection = ({ project, boards, activeId, orderedProjectIds }: { project: Project; boards: Board[]; activeId?: string; orderedProjectIds: string[] }) => {
  const runs = useBoard((state) => state.runs);
  const [isRenaming, setIsRenaming] = useState(false);
  const { open, element } = useContextMenu();
  const isCollapsed = useSidebarLayout((state) => state.collapsedProjectIds.includes(project.id));
  const boardOrder = useSidebarLayout((state) => state.boardOrder[project.id]);
  const { toggleCollapsed, setProjectOrder } = useSidebarLayout.getState();
  const { placement, props } = useReorderable("project", "", project.id, orderedProjectIds, setProjectOrder, !isRenaming);
  const orderedBoards = applyOrder(boards, boardOrder ?? [], true);
  const collapsedActivity = isCollapsed ? strongestActivity(boards.map((board) => activityOf(board, runs, activeId))) : "none";
  return (
    <section className={`sidebar-project ${placement ? `drop-${placement}` : ""}`} {...props}>
      <header onContextMenu={open([{ label: "Rename", run: () => setIsRenaming(true) }, { label: "Import board…", run: () => void importBoard(project.id) }, { label: "Remove project", isDanger: true, run: () => void deleteProject(project) }])}>
        <button className="project-toggle" onClick={() => toggleCollapsed(project.id)} title={isCollapsed ? "Show boards" : "Hide boards"} aria-label={isCollapsed ? "Show boards" : "Hide boards"} aria-expanded={!isCollapsed}>
          <IconRow names={[isCollapsed ? "chevronRight" : "chevronDown"]} />
        </button>
        <IconRow names={["folder"]} />
        <span className="sidebar-project-title" onDoubleClick={() => setIsRenaming(true)}>
          <EditableName
            className="sidebar-project-name"
            value={project.name}
            isEditing={isRenaming}
            onEditingChange={setIsRenaming}
            onCommit={(name) => void sendWorkspaceCommand({ type: "renameProject", projectId: project.id, name }).then(() => useBoard.getState().loadBoards())}
          />
        </span>
        {collapsedActivity !== "none" && <span className={`board-dot is-${collapsedActivity}`} title={ACTIVITY_TITLES[collapsedActivity]} />}
        <span className="badge">{project.mode}</span>
      </header>
      {!isCollapsed && (
        <>
          <div className="muted sidebar-path" title={project.workspacePath}>{project.workspacePath}</div>
          <ul>{orderedBoards.map((board) => <BoardRow key={board.id} board={board} isActive={board.id === activeId} activity={activityOf(board, runs, activeId)} orderedIds={orderedBoards.map((candidate) => candidate.id)} />)}</ul>
          <button className="sidebar-new-board" onClick={() => void createBoardIn(project.id)}><IconRow names={["add"]} />New board</button>
        </>
      )}
      {element}
    </section>
  );
};

export const Sidebar = () => {
  const projects = useBoard((state) => state.projects);
  const boards = useBoard((state) => state.boards);
  const activeId = useBoard((state) => state.board?.id);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isTrashOpen, setIsTrashOpen] = useState(false);
  const projectOrder = useSidebarLayout((state) => state.projectOrder);
  const orderedProjects = applyOrder(projects, projectOrder, false);
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <strong>Projects</strong>
        <button className="sidebar-add-project" onClick={() => setIsDialogOpen(true)} title="Connect a project folder" aria-label="Connect a project folder"><IconRow names={["add"]} />Add project</button>
      </header>
      {projects.length === 0 && <div className="muted sidebar-empty">Connect a folder once, then create as many boards for it as you like.</div>}
      {projects.length > 0 && <div className="muted sidebar-hint">Drag to reorder. Right-click a board to rename, export or import.</div>}
      {orderedProjects.map((project) => (
        <ProjectSection key={project.id} project={project} boards={boards.filter((board) => board.projectId === project.id)} activeId={activeId} orderedProjectIds={orderedProjects.map((candidate) => candidate.id)} />
      ))}
      <button className="sidebar-trash" onClick={() => setIsTrashOpen(true)}><IconRow names={["trash"]} />Trash</button>
      {isDialogOpen && <ProjectDialog onClose={() => setIsDialogOpen(false)} />}
      {isTrashOpen && <TrashDialog onClose={() => setIsTrashOpen(false)} />}
    </aside>
  );
};
