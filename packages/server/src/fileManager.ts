import { spawn } from "node:child_process";
import { dirname } from "node:path";

export interface FileManagerLaunch {
  command: string;
  args: string[];
}

const FINDER_REVEAL_SCRIPT = ["on run argv", 'tell application "Finder"', "reveal POSIX file (item 1 of argv)", "activate", "end tell", "end run"];

export const fileManagerLaunchOf = (path: string, platform: NodeJS.Platform = process.platform): FileManagerLaunch => {
  if (platform === "win32") return { command: "explorer.exe", args: [`/select,${path}`] };
  if (platform === "darwin") return { command: "osascript", args: FINDER_REVEAL_SCRIPT.flatMap((line) => ["-e", line]).concat(path) };
  return { command: "xdg-open", args: [dirname(path)] };
};

export const showInFileManager = (path: string): void => {
  const { command, args } = fileManagerLaunchOf(path);
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: false });
  child.on("error", () => undefined);
  child.unref();
};
