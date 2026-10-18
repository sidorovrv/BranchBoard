import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ENGINE_PACKAGE = "@opencode/cli";
export const DEFAULT_ENGINE_VERSION = "2.0.27";
export const ENGINE_MARKER_FILE = "engine.json";

export interface EnginePlatform {
  os: NodeJS.Platform;
  arch: string;
  isMusl: boolean;
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { linux: "linux", darwin: "darwin", win32: "windows" };

export const isMuslLibc = (): boolean => {
  if (process.platform !== "linux") return false;
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return !header?.glibcVersionRuntime;
};

export const currentPlatform = (): EnginePlatform => ({ os: process.platform, arch: process.arch, isMusl: isMuslLibc() });

export const platformPackages = ({ os, arch, isMusl }: EnginePlatform): string[] => {
  const osName = OS_NAMES[os];
  if (!osName || (arch !== "x64" && arch !== "arm64")) return [];
  const base = `${ENGINE_PACKAGE}-${osName}-${arch}`;
  const variants = arch === "x64" ? [base, `${base}-baseline`] : [base];
  if (os !== "linux") return variants;
  const musl = variants.map((name) => `${name}-musl`);
  return isMusl ? [...musl, ...variants] : [...variants, ...musl];
};

export const engineRoot = (dataDirectory: string): string => join(dataDirectory, "engine");

export const engineFolder = (dataDirectory: string, version: string): string => join(engineRoot(dataDirectory), version);

export const binaryFileName = (os: NodeJS.Platform): string => (os === "win32" ? "opencode.exe" : "opencode");

export const packageBinaryPath = (folder: string, packageName: string, os: NodeJS.Platform): string => join(folder, "node_modules", ...packageName.split("/"), "bin", binaryFileName(os));

export interface EngineMarker {
  version: string;
  packageName: string;
}

export const readEngineMarker = (folder: string): EngineMarker | undefined => {
  try {
    const marker = JSON.parse(readFileSync(join(folder, ENGINE_MARKER_FILE), "utf8"));
    return typeof marker?.version === "string" && typeof marker?.packageName === "string" ? marker : undefined;
  } catch {
    return undefined;
  }
};

export const locateEngine = (dataDirectory: string, version: string, os: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string | undefined => {
  const folder = engineFolder(dataDirectory, version);
  const marker = readEngineMarker(folder);
  if (marker?.version !== version) return undefined;
  const path = packageBinaryPath(folder, marker.packageName, os);
  return exists(path) ? path : undefined;
};
