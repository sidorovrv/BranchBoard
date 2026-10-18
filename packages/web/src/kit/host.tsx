import { createContext, useContext } from "react";

export interface ChatHost {
  fileUrl: (path: string, hash?: string) => string | undefined;
  extractFile?: (path: string, source: HTMLElement) => void;
  fileOpener?: (path: string, hash?: string) => (() => void) | undefined;
}

const UNCONNECTED_HOST: ChatHost = { fileUrl: () => undefined };

export const ChatHostContext = createContext<ChatHost>(UNCONNECTED_HOST);

export const useChatHost = (): ChatHost => useContext(ChatHostContext);
