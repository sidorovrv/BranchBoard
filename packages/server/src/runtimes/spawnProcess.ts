import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface ProcessExit {
  code: number | null;
  stderrTail: string;
}

export interface RunningProcess {
  writeInput(text: string): void;
  endInput(): void;
  lines: AsyncIterable<string>;
  exit: Promise<ProcessExit>;
  kill(): void;
}

export interface LaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type LaunchProcess = (executable: string, args: string[], options: LaunchOptions) => RunningProcess;

const STDERR_TAIL_CHARS = 2000;
const SHELL_UNSAFE = /["%^&|<>!\r\n]/;

export const killTree = (child: ChildProcess) => {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => undefined);
  else child.kill();
};

const needsShell = (executable: string): boolean => process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);

export const quoteForCmdShell = (value: string): string => {
  if (SHELL_UNSAFE.test(value)) throw new Error(`Refusing to pass "${value}" through the Windows command shell`);
  const trailingBackslashes = /\\+$/.exec(value)?.[0] ?? "";
  return `"${value}${trailingBackslashes}"`;
};

export const withoutCurrentDirectorySearch = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, NoDefaultCurrentDirectoryInExePath: "1" });

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];

export const withLoopbackDirect = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const listed = [env.NO_PROXY, env.no_proxy].flatMap((value) => (value ?? "").split(",")).map((entry) => entry.trim()).filter(Boolean);
  const bypass = [...new Set([...listed, ...LOOPBACK_HOSTS])].join(",");
  return { ...env, NO_PROXY: bypass, no_proxy: bypass };
};

export const spawnExecutable =(executable: string, args: string[], options: LaunchOptions): ChildProcess => {
  const spawnOptions = { cwd: options.cwd, env: withoutCurrentDirectorySearch(options.env), stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
  if (!needsShell(executable)) return spawn(executable, args, spawnOptions);
  return spawn(quoteForCmdShell(executable), args.map(quoteForCmdShell), { ...spawnOptions, shell: true });
};

export const launchProcess: LaunchProcess = (executable, args, options) => {
  const child = spawnExecutable(executable, args, options);
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });
  child.stdin?.on("error", () => undefined);
  const exit = new Promise<ProcessExit>((resolve) => {
    child.on("error", (error) => resolve({ code: null, stderrTail: error.message }));
    child.on("close", (code) => resolve({ code, stderrTail: stderrTail.trim() }));
  });
  return {
    writeInput: (text) => void child.stdin?.write(text),
    endInput: () => void child.stdin?.end(),
    lines: createInterface({ input: child.stdout! }),
    exit,
    kill: () => killTree(child),
  };
};

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandOptions extends LaunchOptions {
  timeoutMs: number;
  tailChars?: number;
}

const PROBE_TIMEOUT_MS = 15000;

export const runCommand = (executable: string, args: string[], { timeoutMs, tailChars = Number.MAX_SAFE_INTEGER, ...options }: CommandOptions): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawnExecutable(executable, args, options);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`${executable} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString()).slice(-tailChars)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-tailChars)));
    child.stdin?.on("error", () => undefined);
    child.on("error", (error) => (clearTimeout(timer), reject(error)));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
    child.stdin?.end();
  });

export const readOutput = async (executable: string, args: string[], options: LaunchOptions): Promise<string> => {
  const { code, stdout } = await runCommand(executable, args, { ...options, timeoutMs: PROBE_TIMEOUT_MS });
  if (code !== 0) throw new Error(`${executable} exited with code ${code}`);
  return stdout.trim();
};
