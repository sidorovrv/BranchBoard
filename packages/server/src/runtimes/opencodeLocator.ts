import { join } from "node:path";
import { locateExecutable, npmGlobalDirectories, shimNames, type LocatorEnvironment, type Location } from "./executableLocator";

export type { LocatorEnvironment, Location } from "./executableLocator";

const locatorFor = (command: string, overrideVariable: string) => (environment?: LocatorEnvironment): Location =>
  locateExecutable(
    {
      overrideVariable,
      names: (platform) => shimNames(command, platform),
      knownDirectories: (current) => {
        const common = [join(current.home, ".opencode", "bin"), join(current.home, ".bun", "bin"), join(current.home, ".local", "bin")];
        return current.platform === "win32" ? [...npmGlobalDirectories(current), ...common] : [...common, ...npmGlobalDirectories(current)];
      },
    },
    environment,
  );

export const locateOpencode = locatorFor("opencode", "BRANCHBOARD_OPENCODE_PATH");

export const locateOpencode2 = locatorFor("opencode2", "BRANCHBOARD_OPENCODE2_PATH");
