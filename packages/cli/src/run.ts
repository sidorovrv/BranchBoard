import { defaultDataDirectory } from "../../server/src/dataDirectory";
import { locateClaude } from "../../server/src/runtimes/claudeLocator";
import { locateOpencode } from "../../server/src/runtimes/opencodeLocator";
import { DEFAULT_PORT, installProcessHandlers, startServer } from "../../server/src/start";
import { parseArguments, type RunArguments } from "./args";
import { openBrowser } from "./browser";
import { VERSION } from "./version";

const HELP = `Branchboard ${VERSION}

A whiteboard where every AI chat turn is a node. It runs on your computer and uses the claude or opencode command you already have installed.

Usage: branchboard [options]

  --port <number>    Port to listen on (default ${DEFAULT_PORT})
  --data-dir <dir>   Folder for boards and logs (default: your user data folder)
  --no-open          Do not open the browser
  -v, --version      Print the version
  -h, --help         Print this help
`;

const runtimeSummary = (): string[] => {
  const opencode = locateOpencode();
  const claude = locateClaude();
  return [
    opencode.path ? `OpenCode: found (${opencode.path})` : "OpenCode: not found. Install it (npm install -g opencode-ai) to use it.",
    claude.path ? `Claude: found (${claude.path})` : "Claude: not found. Install the claude command and sign in once by running it.",
  ];
};

const startOrExplain = async (options: RunArguments, webRoot: string, port: number) => {
  try {
    return await startServer({ port, dataDirectory: options.dataDirectory ?? defaultDataDirectory(), webRoot });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code === "EADDRINUSE" ? `Port ${port} is already in use. If Branchboard is already running, open the link it printed; otherwise start this one with --port <number>.` : `Branchboard could not start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};

export const runCli = async (argv: string[], { webRoot }: { webRoot: string }): Promise<void> => {
  const parsed = parseArguments(argv);
  if (parsed.kind === "help") return void console.log(HELP);
  if (parsed.kind === "version") return void console.log(VERSION);
  if (parsed.kind === "error") {
    console.error(`${parsed.message}\n\n${HELP}`);
    process.exit(2);
  }
  process.env.BRANCHBOARD_LOG_LEVEL ??= "info";
  installProcessHandlers();
  const port = parsed.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const { accessLink } = await startOrExplain(parsed, webRoot, port);
  console.log(`Branchboard ${VERSION} is running.\n`);
  runtimeSummary().forEach((line) => console.log(line));
  console.log(`\nOpen this link in your browser (it holds your access key, keep it private):\n${accessLink}\n\nPress Ctrl+C to stop.`);
  if (parsed.shouldOpenBrowser) openBrowser(accessLink);
};
