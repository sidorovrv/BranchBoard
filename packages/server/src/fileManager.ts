import { spawn } from "node:child_process";
import { dirname, win32 } from "node:path";

export interface FileManagerLaunch {
  command: string;
  args: string[];
  isVerbatim?: boolean;
}

export const fileManagerLaunchOf = (path: string, platform: NodeJS.Platform = process.platform): FileManagerLaunch => {
  if (platform === "win32") return { command: "explorer.exe", args: [`/select,"${win32.normalize(path)}"`], isVerbatim: true };
  if (platform === "darwin") return { command: "open", args: ["-R", path] };
  return { command: "xdg-open", args: [dirname(path)] };
};

export const showInFileManager = (path: string): void => {
  const { command, args, isVerbatim } = fileManagerLaunchOf(path);
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: false, windowsVerbatimArguments: isVerbatim });
  child.on("error", () => undefined);
  child.unref();
};
