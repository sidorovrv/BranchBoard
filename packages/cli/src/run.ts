import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installCommandFor, RUNTIMES } from "@branchboard/core";
import { accessLinkOf, loadAccessToken } from "../../server/src/accessToken";
import { dataDirectoryId, defaultDataDirectory } from "../../server/src/dataDirectory";
import { locateClaude } from "../../server/src/runtimes/claudeLocator";
import { locateCodex } from "../../server/src/runtimes/codexLocator";
import { locateOpencode } from "../../server/src/runtimes/opencodeLocator";
import { installProcessHandlers, startServer } from "../../server/src/start";
import { VERSION } from "../../server/src/version";
import { parseArguments } from "./args";
import { openBrowser } from "./browser";
import { readLastPort, resolvePort, writeLastPort } from "./ports";
import { runAutoUpdate, runUpdate, shouldAutoUpdate } from "./update";

const HELP = `Branchboard ${VERSION}

A whiteboard where every AI chat turn is a node. It runs on your computer and uses the claude, codex or opencode command you already have installed.

Usage: branchboard [options]

  --port <number>    Port to listen on
  --data-dir <dir>   Folder for boards and logs
  --no-open          Do not open the browser
  --offline          Make no internet requests
  --no-auto-update   Do not install updates at start
  -v, --version      Print the version
  -h, --help         Print this help

  update             Install the newest version
  update --check     Only report the newest version
`;

type CliRuntimeId = "opencode" | "claude" | "codex";

const CLI_LOCATORS: Record<CliRuntimeId, () => { path?: string }> = { opencode: locateOpencode, claude: locateClaude, codex: locateCodex };

export const runtimeSummary = (platform: string = process.platform, locators: Partial<Record<CliRuntimeId, () => { path?: string }>> = CLI_LOCATORS): string[] =>
  (Object.keys(locators) as CliRuntimeId[]).map((id) => {
    const { label, setup, pathVariable } = RUNTIMES[id];
    const located = locators[id]!();
    if (located.path) return `${label}: found (${located.path})`;
    const install = installCommandFor(id, platform);
    return `${label}: not found.${install ? ` Install it with: ${install}.` : ""}${setup.signIn ? ` Then sign in once by running: ${setup.signIn}.` : ""} More: ${setup.docsUrl} (or set ${pathVariable} to its full path).`;
  });

const fatal = (message: string, code = 1): never => {
  console.error(message);
  return process.exit(code);
};

const portFromEnvironment = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fatal(`The PORT environment variable must be a number from 1 to 65535, not "${value}".`, 2);
};

const startOrExplain = async (dataDirectory: string, webRoot: string, port: number) => {
  try {
    return await startServer({ port, dataDirectory, webRoot });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fatal(code === "EADDRINUSE" ? `Port ${port} was taken just now. Start again, or choose one with --port <number>.` : `Branchboard could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const announce = (accessLink: string, shouldOpenBrowser: boolean, lines: string[]) => {
  lines.forEach((line) => console.log(line));
  console.log(`\nOpen this link in your browser (it holds your access key, keep it private):\n${accessLink}`);
  if (shouldOpenBrowser) openBrowser(accessLink);
};

export const runCli = async (argv: string[]): Promise<void> => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "web");
  const parsed = parseArguments(argv);
  if (parsed.kind === "help") return void console.log(HELP);
  if (parsed.kind === "version") return void console.log(VERSION);
  if (parsed.kind === "update") return process.exit(await runUpdate(parsed));
  if (parsed.kind === "error") return fatal(`${parsed.message}\n\n${HELP}`, 2);
  if (parsed.offline) process.env.BRANCHBOARD_OFFLINE = "1";
  const dataDirectory = parsed.dataDirectory ?? defaultDataDirectory();
  const requestedPort = parsed.port ?? portFromEnvironment(process.env.PORT);
  const portFile = join(dataDirectory, "port");
  const resolution = await resolvePort({ requestedPort, lastPort: readLastPort(portFile), dataDirId: dataDirectoryId(dataDirectory) });
  if (resolution.kind === "none") return fatal(`Port ${requestedPort} is already in use. Choose another with --port <number>.`);
  if (resolution.kind === "reuse") {
    const link = accessLinkOf(resolution.port, loadAccessToken(join(dataDirectory, "access-token")));
    return announce(link, parsed.shouldOpenBrowser, [`Branchboard is already running on port ${resolution.port} with this data folder.`]);
  }
  installProcessHandlers();
  const { accessLink, port } = await startOrExplain(dataDirectory, webRoot, resolution.port);
  writeLastPort(portFile, port);
  announce(accessLink, parsed.shouldOpenBrowser, [`Branchboard ${VERSION} is running.\n`, ...runtimeSummary()]);
  console.log("\nPress Enter or Ctrl+C to stop.");
  if (process.stdin.isTTY) process.stdin.once("data", () => process.exit(0));
  if (shouldAutoUpdate(parsed)) void runAutoUpdate();
};
