import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIMES } from "@branchboard/core";
import { accessLinkOf, loadAccessToken } from "../../server/src/accessToken";
import { dataDirectoryId, defaultDataDirectory } from "../../server/src/dataDirectory";
import { locateClaude } from "../../server/src/runtimes/claudeLocator";
import { locateCodex } from "../../server/src/runtimes/codexLocator";
import { locateOpencode } from "../../server/src/runtimes/opencodeLocator";
import { installProcessHandlers, shutDown, startServer, type StartOptions } from "../../server/src/start";
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
  --host             Accept connections from other devices on the local network
  --no-key           Open without the access key
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

export const runtimeSummary = (locators: Partial<Record<CliRuntimeId, () => { path?: string }>> = CLI_LOCATORS): string[] => {
  const found = (Object.keys(locators) as CliRuntimeId[]).flatMap((id) => {
    const path = locators[id]!().path;
    return path ? [`${RUNTIMES[id].label}: found (${path})`] : [];
  });
  return found.length > 0 ? found : ["No claude, codex or opencode command was found. The setup guide in the browser shows how to install one."];
};

const fatal = (message: string, code = 1): never => {
  console.error(message);
  return process.exit(code);
};

const portFromEnvironment = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fatal(`The PORT environment variable must be a number from 1 to 65535, not "${value}".`, 2);
};

const startOrExplain = async (options: StartOptions) => {
  const { port } = options;
  try {
    return await startServer(options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fatal(code === "EADDRINUSE" ? `Port ${port} was taken just now. Start again, or choose one with --port <number>.` : `Branchboard could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
};

interface Links {
  accessLink: string;
  networkLinks: string[];
  isKeyless?: boolean;
}

const announce = ({ accessLink, networkLinks, isKeyless }: Links, shouldOpenBrowser: boolean, lines: string[]) => {
  lines.forEach((line) => console.log(line));
  console.log(`\nOpen this link in your browser${isKeyless ? "" : " (it holds your access key, keep it private)"}:\n${accessLink}`);
  if (networkLinks.length > 0) console.log(`\nOn another device in the same network, open one of these links:\n${networkLinks.join("\n")}`);
  if (isKeyless) console.log("\nThe access key is off. Any program on this computer can use Branchboard.");
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
  if (!parsed.shouldAutoUpdate) process.env.BRANCHBOARD_AUTOUPDATE = "0";
  const dataDirectory = parsed.dataDirectory ?? defaultDataDirectory();
  const requestedPort = parsed.port ?? portFromEnvironment(process.env.PORT);
  const portFile = join(dataDirectory, "port");
  const resolution = await resolvePort({ requestedPort, lastPort: readLastPort(portFile), dataDirId: dataDirectoryId(dataDirectory) });
  if (resolution.kind === "none") return fatal(`Port ${requestedPort} is already in use. Choose another with --port <number>.`);
  if (resolution.kind === "reuse") {
    const link = accessLinkOf(resolution.port, loadAccessToken(join(dataDirectory, "access-token")));
    return announce({ accessLink: link, networkLinks: [] }, parsed.shouldOpenBrowser, [`Branchboard is already running on port ${resolution.port} with this data folder.`]);
  }
  installProcessHandlers();
  const started = await startOrExplain({ port: resolution.port, dataDirectory, webRoot, isOnNetwork: parsed.isOnNetwork, isKeyless: parsed.isKeyless });
  writeLastPort(portFile, started.port);
  announce({ ...started, isKeyless: parsed.isKeyless }, parsed.shouldOpenBrowser, [`Branchboard ${VERSION} is running.\n`, ...runtimeSummary()]);
  console.log("\nPress Enter or Ctrl+C to stop.");
  if (process.stdin.isTTY) process.stdin.once("data", () => void shutDown("Enter pressed"));
  if (shouldAutoUpdate(parsed)) void runAutoUpdate();
};
