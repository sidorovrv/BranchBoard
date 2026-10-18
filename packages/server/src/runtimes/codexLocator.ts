import { join } from "node:path";
import { locateExecutable, npmGlobalDirectories, type LocatorEnvironment, type Location } from "./executableLocator";

export const CODEX_PATH_VARIABLE = "BRANCHBOARD_CODEX_PATH";

const codexNames = (platform: NodeJS.Platform): string[] => (platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"]);

const installerDirectories = ({ platform, env, home }: LocatorEnvironment): string[] =>
  platform === "win32" ? [join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin")] : [join(home, ".local", "bin")];

export const locateCodex = (environment?: LocatorEnvironment): Location =>
  locateExecutable({ overrideVariable: CODEX_PATH_VARIABLE, names: codexNames, knownDirectories: (current) => [...installerDirectories(current), ...npmGlobalDirectories(current)] }, environment);
