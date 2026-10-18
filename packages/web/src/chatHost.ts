import { createAndFocus } from "./actions";
import { workspaceFileUrl } from "./api";
import type { ChatHost } from "./kit/host";
import { boardId } from "./store";

export const boardChatHost: ChatHost = {
  fileUrl: (path, hash) => workspaceFileUrl(boardId(), path, hash),
  extractFile: (path, source) => {
    const originId = source.closest(".react-flow__node")?.getAttribute("data-id") ?? undefined;
    void createAndFocus({ type: "extractFile", path, originId });
  },
};
