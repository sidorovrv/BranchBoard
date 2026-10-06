import { spawn } from "node:child_process";

export interface BrowserLaunch {
  command: string;
  args: string[];
}

export const browserLaunchOf = (url: string, platform: NodeJS.Platform = process.platform): BrowserLaunch => {
  if (platform === "win32") return { command: "cmd.exe", args: ["/c", "start", '""', url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
};

export const openBrowser = (url: string): void => {
  const { command, args } = browserLaunchOf(url);
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsVerbatimArguments: process.platform === "win32" });
  child.on("error", () => undefined);
  child.unref();
};
