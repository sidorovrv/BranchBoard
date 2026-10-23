import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/jetbrains-mono";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import "./kit/chat.css";
import "./kit/settings.css";
import { App } from "./App";
import { boardChatHost } from "./chatHost";
import { ChatHostContext } from "./kit/host";
import { loadServerSettings, resolveTheme, useSettings } from "./settings";

void loadServerSettings().then(() => {
  document.documentElement.dataset.theme = resolveTheme(useSettings.getState().settings.theme);
  createRoot(document.getElementById("root")!).render(
    <ChatHostContext.Provider value={boardChatHost}>
      <App />
    </ChatHostContext.Provider>,
  );
});
