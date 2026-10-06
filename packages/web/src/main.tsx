import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/jetbrains-mono";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { resolveTheme, useSettings } from "./settings";

document.documentElement.dataset.theme = resolveTheme(useSettings.getState().settings.theme);

createRoot(document.getElementById("root")!).render(<App />);
