import type { Part } from "@branchboard/core";
import { createAndFocus } from "./actions";
import { fetchToolOutput, workspaceFileUrl } from "./api";
import type { ChatHost } from "./kit/host";
import { boardId } from "./store";

export const boardChatHost: ChatHost = {
  fileUrl: (path, hash) => workspaceFileUrl(boardId(), path, hash),
  extractFile: (path, source) => {
    const originId = source.closest(".react-flow__node")?.getAttribute("data-id") ?? undefined;
    void createAndFocus({ type: "extractFile", path, originId });
  },
  toolOutput: (part) => fetchToolOutput(boardId(), (part as Part).nodeId, part.id),
};
