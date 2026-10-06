import { join } from "node:path";
import { locateExecutable, npmGlobalDirectories, shimNames, type LocatorEnvironment, type Location } from "./executableLocator";

export type { LocatorEnvironment, Location } from "./executableLocator";

export const locateOpencode = (environment?: LocatorEnvironment): Location =>
  locateExecutable(
    {
      overrideVariable: "BRANCHBOARD_OPENCODE_PATH",
      names: (platform) => shimNames("opencode", platform),
      knownDirectories: (current) => {
        const common = [join(current.home, ".opencode", "bin"), join(current.home, ".bun", "bin"), join(current.home, ".local", "bin")];
        return current.platform === "win32" ? [...npmGlobalDirectories(current), ...common] : [...common, ...npmGlobalDirectories(current)];
      },
    },
    environment,
  );
