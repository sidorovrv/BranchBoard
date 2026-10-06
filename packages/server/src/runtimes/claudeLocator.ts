import { join } from "node:path";
import { locateExecutable, npmGlobalDirectories, shimNames, type LocatorEnvironment, type Location } from "./executableLocator";

export const CLAUDE_PATH_VARIABLE = "BRANCHBOARD_CLAUDE_PATH";

const claudeNames = (platform: NodeJS.Platform): string[] => (platform === "win32" ? ["claude.exe", "claude.cmd"] : shimNames("claude", platform));

export const locateClaude = (environment?: LocatorEnvironment): Location =>
  locateExecutable(
    {
      overrideVariable: CLAUDE_PATH_VARIABLE,
      names: claudeNames,
      knownDirectories: (current) => [join(current.home, ".local", "bin"), join(current.home, ".claude", "local"), ...npmGlobalDirectories(current)],
    },
    environment,
  );
