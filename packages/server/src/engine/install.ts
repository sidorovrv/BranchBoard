import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RecoverableError } from "../run/types";
import { spawnExecutable } from "../runtimes/spawnProcess";
import { ENGINE_MARKER_FILE, ENGINE_PACKAGE, currentPlatform, engineFolder, engineRoot, locateEngine, packageBinaryPath, platformPackages, type EnginePlatform } from "./locator";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunCommand = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

export type EnginePhase = "idle" | "installing" | "failed" | "ready";

export type FailureCause = "offline" | "npm-missing" | "disk-full" | "other";

export interface EngineSetupState {
  phase: EnginePhase;
  version?: string;
  message?: string;
  cause?: FailureCause;
}

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const VERSION_TIMEOUT_MS = 20 * 1000;
const OUTPUT_TAIL_CHARS = 1500;

export const defaultRunCommand: RunCommand = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawnExecutable(command, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), command.includes("npm") ? INSTALL_TIMEOUT_MS : VERSION_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString()).slice(-OUTPUT_TAIL_CHARS)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-OUTPUT_TAIL_CHARS)));
    child.on("error", (error) => (clearTimeout(timer), reject(error)));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
    child.stdin?.end();
  });

const OFFLINE_PATTERN = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|network|offline|ERR_SOCKET/i;
const DISK_PATTERN = /ENOSPC|no space left|disk full/i;

export const classifyInstallFailure = (error: unknown, stderr = ""): { cause: FailureCause; message: string } => {
  const text = `${error instanceof Error ? error.message : String(error ?? "")} ${stderr}`;
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { cause: "npm-missing", message: "The engine download needs npm, and the npm command was not found. Install Node.js with npm, then try again." };
  if (DISK_PATTERN.test(text)) return { cause: "disk-full", message: "The engine could not be installed because the disk is full." };
  if (OFFLINE_PATTERN.test(text)) return { cause: "offline", message: "The engine could not be downloaded. Check the internet connection, then try again." };
  return { cause: "other", message: `The engine install failed: ${stderr.trim().split("\n").slice(-3).join(" ") || text.trim() || "unknown error"}` };
};

export const npmArguments = (prefix: string, version: string, platform: EnginePlatform): string[] => [
  "install",
  "--prefix",
  prefix,
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  `--os=${platform.os}`,
  `--cpu=${platform.arch}`,
  ...(platform.os === "linux" ? [`--libc=${platform.isMusl ? "musl" : "glibc"}`] : []),
  `${ENGINE_PACKAGE}@${version}`,
];

const packageJsonOf = (folder: string, packageName: string): { name?: string; version?: string } => {
  try {
    return JSON.parse(readFileSync(join(folder, "node_modules", ...packageName.split("/"), "package.json"), "utf8"));
  } catch {
    return {};
  }
};

const RENAME_ATTEMPTS = 20;
const RENAME_RETRY_MS = 250;
const LOCKED_FILE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

const renameWhenReleased = async (from: string, to: string): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !LOCKED_FILE_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
    }
  }
};

export interface InstallerOptions {
  dataDirectory: string;
  run?: RunCommand;
  platform?: EnginePlatform;
}

export const createEngineInstaller = ({ dataDirectory, run = defaultRunCommand, platform = currentPlatform() }: InstallerOptions) => {
  const pending = new Map<string, Promise<string>>();
  const listeners = new Set<(state: EngineSetupState) => void>();
  let current: EngineSetupState = { phase: "idle" };

  const setState = (next: EngineSetupState) => {
    current = next;
    listeners.forEach((listener) => listener(next));
  };

  const pickBinary = async (folder: string, version: string): Promise<string | undefined> => {
    for (const packageName of platformPackages(platform)) {
      const path = packageBinaryPath(folder, packageName, platform.os);
      if (!existsSync(path)) continue;
      const result = await run(path, ["--version"], folder).catch(() => undefined);
      if (result?.code === 0 && result.stdout.includes(version)) return packageName;
    }
    return undefined;
  };

  const install = async (version: string): Promise<string> => {
    const root = engineRoot(dataDirectory);
    mkdirSync(root, { recursive: true });
    const temporary = mkdtempSync(join(root, `.install-${version}-`));
    try {
      setState({ phase: "installing", version, message: `Downloading the engine ${version}` });
      const npm = platform.os === "win32" ? "npm.cmd" : "npm";
      const result = await run(npm, npmArguments(temporary, version, platform), temporary);
      if (result.code !== 0) throw Object.assign(new Error("npm install failed"), { stderr: result.stderr });
      const main = packageJsonOf(temporary, ENGINE_PACKAGE);
      if (main.name !== ENGINE_PACKAGE || main.version !== version) throw new Error(`The downloaded package is ${main.name}@${main.version}, not ${ENGINE_PACKAGE}@${version}`);
      setState({ phase: "installing", version, message: "Checking the engine" });
      const packageName = await pickBinary(temporary, version);
      if (!packageName) throw new Error(`No ${platform.os}-${platform.arch} engine binary ran with version ${version}`);
      writeFileSync(join(temporary, ENGINE_MARKER_FILE), JSON.stringify({ version, packageName }));
      const final = engineFolder(dataDirectory, version);
      rmSync(final, { recursive: true, force: true, maxRetries: RENAME_ATTEMPTS, retryDelay: RENAME_RETRY_MS });
      await renameWhenReleased(temporary, final);
      const binary = locateEngine(dataDirectory, version, platform.os);
      if (!binary) throw new Error("The engine was installed but its binary is missing");
      setState({ phase: "ready", version });
      return binary;
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      const failure = classifyInstallFailure(error, (error as { stderr?: string })?.stderr);
      setState({ phase: "failed", version, message: failure.message, cause: failure.cause });
      throw new RecoverableError(failure.message, "setup");
    }
  };

  const ensure = (version: string): Promise<string> => {
    const installed = locateEngine(dataDirectory, version, platform.os);
    if (installed) {
      if (current.phase !== "ready" || current.version !== version) setState({ phase: "ready", version });
      return Promise.resolve(installed);
    }
    const known = pending.get(version);
    if (known) return known;
    const started = install(version).finally(() => pending.delete(version));
    pending.set(version, started);
    return started;
  };

  const pruneOtherVersions = (keepVersion: string) => {
    const root = engineRoot(dataDirectory);
    if (!existsSync(root)) return;
    const isInstalling = (entry: string) => [...pending.keys()].some((version) => entry === version || entry.startsWith(`.install-${version}-`));
    for (const entry of readdirSync(root)) if (entry !== keepVersion && !isInstalling(entry)) rmSync(join(root, entry), { recursive: true, force: true });
  };

  return {
    ensure,
    pruneOtherVersions,
    locate: (version: string) => locateEngine(dataDirectory, version, platform.os),
    state: () => current,
    subscribe: (listener: (state: EngineSetupState) => void) => (listeners.add(listener), () => void listeners.delete(listener)),
  };
};

export type EngineInstaller = ReturnType<typeof createEngineInstaller>;
