import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface LocatorEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  isFile: (path: string) => boolean;
}

export interface Location {
  path?: string;
  searched: string[];
}

export interface ExecutableSpec {
  overrideVariable: string;
  names: (platform: NodeJS.Platform) => string[];
  knownDirectories: (environment: LocatorEnvironment) => string[];
}

const realIsFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

export const defaultEnvironment = (): LocatorEnvironment => ({ platform: process.platform, env: process.env, home: homedir(), isFile: realIsFile });

export const shimNames = (name: string, platform: NodeJS.Platform): string[] => (platform === "win32" ? [`${name}.cmd`, `${name}.exe`] : [name]);

export const npmGlobalDirectories = ({ platform, env, home }: LocatorEnvironment): string[] =>
  platform === "win32"
    ? [env.APPDATA ? join(env.APPDATA, "npm") : join(home, "AppData", "Roaming", "npm"), join(home, "scoop", "shims")]
    : ["/usr/local/bin", "/opt/homebrew/bin", join(home, ".npm-global", "bin")];

export const locateExecutable = (spec: ExecutableSpec, environment: LocatorEnvironment = defaultEnvironment()): Location => {
  const { platform, env, isFile } = environment;
  const override = env[spec.overrideVariable];
  if (override) return { path: isFile(override) ? override : undefined, searched: [override] };
  const pathDirectories = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const directories = [...new Set([...pathDirectories, ...spec.knownDirectories(environment)])];
  const candidates = directories.flatMap((directory) => spec.names(platform).map((name) => join(directory, name)));
  return { path: candidates.find(isFile), searched: directories };
};
