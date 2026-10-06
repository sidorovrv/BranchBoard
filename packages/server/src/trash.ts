import { now, type Board, type BoardGraph, type GraphNode, type Id, type PendingRequest, type Project, type TrashListing, type TrashedNodeGroup } from "@branchboard/core";
import type { AttachmentStore } from "./attachments";
import { RefusedError, type BoardService } from "./boards";
import type { Repository } from "./db";
import { log } from "./log";

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ATTACHMENT_GRACE_MS = 60 * 60 * 1000;

export const createTrashService = (repository: Repository, boards: BoardService, attachments: AttachmentStore) => {
  const allProjects = () => repository.listAll<Project>("projects");
  const allBoards = () => repository.listAll<Board>("boards");
  const liveBoards = () => allBoards().filter((board) => !board.deleted);

  const deletedNodesOf = (boardId: Id): GraphNode[] => Object.values(boards.stateOf(boardId).graph.nodes).filter((node) => node.deleted);

  const stampLegacyDeletions = () => {
    const at = now();
    allProjects().filter((project) => project.deleted && project.deletedAt === undefined).forEach((project) => boards.saveProject({ ...project, deletedAt: at }));
    allBoards().filter((board) => board.deleted && board.deletedAt === undefined).forEach((board) => boards.saveBoard({ ...board, deletedAt: at }));
    for (const board of liveBoards()) {
      const legacy = deletedNodesOf(board.id).filter((node) => node.deletedAt === undefined);
      if (legacy.length === 0) continue;
      const stamped = legacy.map((node) => ({ ...node, deletedAt: at }));
      stamped.forEach((node) => (boards.stateOf(board.id).graph.nodes[node.id] = node));
      repository.upsertMany("nodes", () => board.id, stamped);
    }
  };

  const groupDeletedNodes = (board: Board): TrashedNodeGroup[] => {
    const byTime = new Map<number, GraphNode[]>();
    deletedNodesOf(board.id).forEach((node) => byTime.set(node.deletedAt ?? 0, [...(byTime.get(node.deletedAt ?? 0) ?? []), node]));
    return [...byTime.entries()].map(([deletedAt, nodes]) => ({
      boardId: board.id,
      boardTitle: board.title,
      deletedAt,
      nodeIds: nodes.map((node) => node.id),
      titles: nodes.filter((node) => !node.satelliteOf).map((node) => node.title),
    }));
  };

  const list = (): TrashListing => {
    const projects = allProjects();
    const boardsList = allBoards();
    const wasDeletedWithProject = (board: Board) => {
      const project = projects.find((candidate) => candidate.id === board.projectId);
      return Boolean(project?.deleted) && project!.deletedAt === board.deletedAt;
    };
    return {
      projects: projects
        .filter((project) => project.deleted)
        .map((project) => ({ id: project.id, name: project.name, deletedAt: project.deletedAt ?? 0, boardCount: boardsList.filter((board) => board.projectId === project.id).length })),
      boards: boardsList
        .filter((board) => board.deleted && !wasDeletedWithProject(board))
        .map((board) => ({ id: board.id, title: board.title, projectName: projects.find((project) => project.id === board.projectId)?.name ?? "", deletedAt: board.deletedAt ?? 0 })),
      nodeGroups: liveBoards().flatMap(groupDeletedNodes),
    };
  };

  const reviveProject = (project: Project, withBoards: boolean) => {
    boards.saveProject({ ...project, deleted: false, deletedAt: undefined, updatedAt: now() });
    if (!withBoards) return;
    allBoards()
      .filter((board) => board.projectId === project.id && board.deleted && board.deletedAt === project.deletedAt)
      .forEach((board) => boards.saveBoard({ ...board, deleted: false, deletedAt: undefined, updatedAt: now() }));
  };

  const restoreProject = (projectId: Id) => {
    const project = allProjects().find((candidate) => candidate.id === projectId && candidate.deleted);
    if (!project) throw new RefusedError("That project is not in the trash");
    reviveProject(project, true);
  };

  const restoreBoard = (boardId: Id) => {
    const board = allBoards().find((candidate) => candidate.id === boardId && candidate.deleted);
    if (!board) throw new RefusedError("That board is not in the trash");
    const project = allProjects().find((candidate) => candidate.id === board.projectId);
    if (project?.deleted) reviveProject(project, false);
    boards.saveBoard({ ...board, deleted: false, deletedAt: undefined, updatedAt: now() });
  };

  const purgeBoard = (boardId: Id) => {
    repository.removeBoardRows(boardId);
    boards.forget(boardId);
  };

  const purgeProject = (project: Project) => {
    allBoards().filter((board) => board.projectId === project.id).forEach((board) => purgeBoard(board.id));
    repository.remove("projects", [project.id]);
  };

  const purgeNodes = (boardId: Id, nodeIds: Id[]) => {
    const state = boards.stateOf(boardId);
    const removed = new Set(nodeIds);
    const edgeIds = Object.values(state.graph.edges).filter((edge) => removed.has(edge.fromId) || removed.has(edge.toId)).map((edge) => edge.id);
    repository.remove("nodes", nodeIds);
    repository.remove("edges", edgeIds);
    repository.remove("parts", repository.list<{ id: string; nodeId: Id }>("parts", boardId).filter((part) => removed.has(part.nodeId)).map((part) => part.id));
    repository.remove("requests", repository.list<PendingRequest>("requests", boardId).filter((request) => removed.has(request.nodeId)).map((request) => request.id));
    const graph: BoardGraph = {
      nodes: Object.fromEntries(Object.entries(state.graph.nodes).filter(([id]) => !removed.has(id))),
      edges: Object.fromEntries(Object.entries(state.graph.edges).filter(([id]) => !edgeIds.includes(id))),
    };
    state.graph = graph;
    nodeIds.forEach((id) => delete state.parts[id]);
    state.undoStack = [];
    state.redoStack = [];
  };

  const sweepAttachments = (graceMs = ATTACHMENT_GRACE_MS): number => {
    const referenced = boards.referencedAttachmentIds();
    const cutoff = now() - graceMs;
    const orphans = attachments.listStored().filter((file) => !referenced.has(file.id) && file.modifiedAt <= cutoff);
    orphans.forEach((file) => attachments.remove(file.id));
    if (orphans.length > 0) log.info("trash", `Removed ${orphans.length} unreferenced attachment file(s)`);
    return orphans.length;
  };

  const attachmentIdsOfBoard = (boardId: Id): string[] =>
    repository.list<GraphNode>("nodes", boardId).flatMap((node) => (node.attachments ?? []).map((attachment) => attachment.id));

  const attachmentIdsOfNodes = (boardId: Id, nodeIds: Id[]): string[] =>
    nodeIds.flatMap((id) => (boards.stateOf(boardId).graph.nodes[id]?.attachments ?? []).map((attachment) => attachment.id));

  const removeUnreferenced = (candidateIds: string[]) => {
    const referenced = boards.referencedAttachmentIds();
    candidateIds.filter((id) => !referenced.has(id)).forEach((id) => attachments.remove(id));
  };

  const purge = (isDue: (deletedAt: number) => boolean) => {
    const current = list();
    const projects = allProjects();
    const freed: string[] = [];
    current.projects
      .filter((entry) => isDue(entry.deletedAt))
      .forEach((entry) => {
        const project = projects.find((candidate) => candidate.id === entry.id)!;
        allBoards().filter((board) => board.projectId === project.id).forEach((board) => freed.push(...attachmentIdsOfBoard(board.id)));
        purgeProject(project);
      });
    current.boards
      .filter((entry) => isDue(entry.deletedAt))
      .forEach((entry) => {
        freed.push(...attachmentIdsOfBoard(entry.id));
        purgeBoard(entry.id);
      });
    current.nodeGroups
      .filter((group) => isDue(group.deletedAt))
      .forEach((group) => {
        freed.push(...attachmentIdsOfNodes(group.boardId, group.nodeIds));
        purgeNodes(group.boardId, group.nodeIds);
      });
    removeUnreferenced(freed);
    sweepAttachments();
  };

  const emptyTrash = () => purge(() => true);

  const purgeExpired = () => purge((deletedAt) => now() - deletedAt > TRASH_RETENTION_MS);

  stampLegacyDeletions();

  return { list, restoreProject, restoreBoard, emptyTrash, purgeExpired, sweepAttachments };
};

export type TrashService = ReturnType<typeof createTrashService>;
