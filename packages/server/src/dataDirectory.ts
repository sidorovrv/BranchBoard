import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DataDirectoryEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (path: string) => boolean;
}

const LEGACY_NAME = "WanderBoard";

export const firstExisting = (candidates: string[], exists: (path: string) => boolean = existsSync): string => candidates.find(exists) ?? candidates[0];

const platformBase = ({ platform, env, home }: DataDirectoryEnvironment): { base: string; name: string } => {
  if (platform === "win32") return { base: env.LOCALAPPDATA ?? join(home, "AppData", "Local"), name: "Branchboard" };
  if (platform === "darwin") return { base: join(home, "Library", "Application Support"), name: "Branchboard" };
  return { base: env.XDG_DATA_HOME ?? join(home, ".local", "share"), name: "branchboard" };
};

export const defaultDataDirectory = (environment: DataDirectoryEnvironment = { platform: process.platform, env: process.env, home: homedir(), exists: existsSync }): string => {
  if (environment.env.BRANCHBOARD_DATA_DIR) return environment.env.BRANCHBOARD_DATA_DIR;
  const { base, name } = platformBase(environment);
  return firstExisting([join(base, name), join(base, LEGACY_NAME)], environment.exists);
};
