import { createContext, useContext } from "react";
import type { ChatPart } from "@branchboard/core";

export interface ChatHost {
  fileUrl: (path: string, hash?: string) => string | undefined;
  extractFile?: (path: string, source: HTMLElement) => void;
  fileOpener?: (path: string, hash?: string) => (() => void) | undefined;
  toolOutput?: (part: ChatPart) => Promise<string>;
}

const UNCONNECTED_HOST: ChatHost = { fileUrl: () => undefined };

export const ChatHostContext = createContext<ChatHost>(UNCONNECTED_HOST);

export const useChatHost = (): ChatHost => useContext(ChatHostContext);
