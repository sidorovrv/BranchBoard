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
const SHELL_UNSAFE = /["%^&|<>\r\n]/;

export const killTree = (child: ChildProcess) => {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => undefined);
  else child.kill();
};

const needsShell = (executable: string): boolean => process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);

const assertShellSafe = (value: string) => {
  if (SHELL_UNSAFE.test(value)) throw new Error(`Refusing to pass "${value}" through the Windows command shell`);
  return `"${value}"`;
};

export const withoutCurrentDirectorySearch = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, NoDefaultCurrentDirectoryInExePath: "1" });

export const spawnExecutable = (executable: string, args: string[], options: LaunchOptions): ChildProcess => {
  const spawnOptions = { cwd: options.cwd, env: withoutCurrentDirectorySearch(options.env), stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
  if (!needsShell(executable)) return spawn(executable, args, spawnOptions);
  return spawn(assertShellSafe(executable), args.map(assertShellSafe), { ...spawnOptions, shell: true });
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

export const readOutput = (executable: string, args: string[], options: LaunchOptions): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawnExecutable(executable, args, options);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(`${executable} exited with code ${code}`))));
    child.stdin?.end();
  });
