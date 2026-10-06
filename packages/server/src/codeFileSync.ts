import { readFileSync, statSync } from "node:fs";
import { liveNodes, MAX_EXTRACTED_FILE_BYTES, type GraphNode, type Id } from "@branchboard/core";
import { RefusedError, type BoardService } from "./boards";
import { log } from "./log";
import { existingWorkspaceFile } from "./workspaceFiles";

export const CODE_SYNC_INTERVAL_MS = 2000;

const textOf = (path: string, size: number): string | undefined => {
  if (size > MAX_EXTRACTED_FILE_BYTES) return undefined;
  const content = readFileSync(path, "utf8");
  return content.includes("\0") ? undefined : content;
};

export const createCodeFileSync = (boards: BoardService) => {
  const seenSignatures = new Map<Id, string>();

  const syncNode = (boardId: Id, workspacePath: string, node: GraphNode) => {
    const path = existingWorkspaceFile(workspacePath, node.filePath ?? "");
    if (!path) return;
    const { mtimeMs, size } = statSync(path);
    const signature = `${mtimeMs}:${size}`;
    if (seenSignatures.get(node.id) === signature) return;
    const content = textOf(path, size);
    if (content !== undefined && content !== node.prompt) boards.commitRunPatch(boardId, { type: "editNode", nodeId: node.id, fields: { prompt: content } });
    seenSignatures.set(node.id, signature);
  };

  const syncBoard = (boardId: Id) => {
    const { board, graph } = boards.stateOf(boardId);
    for (const node of liveNodes(graph).filter((candidate) => candidate.kind === "code" && candidate.filePath && !candidate.sourceAttachmentId && !candidate.gitRef)) {
      try {
        syncNode(boardId, board.workspacePath, node);
      } catch (error) {
        if (!(error instanceof RefusedError)) log.warn("codeSync", `Code node ${node.id} not refreshed`, error);
      }
    }
  };

  const syncAll = () =>
    boards.loadedBoardIds().forEach((boardId) => {
      try {
        syncBoard(boardId);
      } catch (error) {
        log.warn("codeSync", `Board ${boardId} not synced`, error);
      }
    });

  const start = (): (() => void) => {
    const timer = setInterval(syncAll, CODE_SYNC_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  };

  return { syncAll, start };
};
