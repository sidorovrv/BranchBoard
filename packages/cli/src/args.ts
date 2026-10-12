export interface RunArguments {
  kind: "run";
  port?: number;
  dataDirectory?: string;
  shouldOpenBrowser: boolean;
  offline?: true;
  shouldAutoUpdate: boolean;
}

export interface UpdateArguments {
  kind: "update";
  isCheckOnly: boolean;
}

export type ParsedArguments = RunArguments | UpdateArguments | { kind: "help" } | { kind: "version" } | { kind: "error"; message: string };

const MAX_PORT = 65535;

const portOf = (text: string | undefined): number | undefined => {
  const port = Number(text);
  return text !== undefined && Number.isInteger(port) && port >= 1 && port <= MAX_PORT ? port : undefined;
};

const parseUpdateArguments = (argv: string[]): ParsedArguments => {
  const update: UpdateArguments = { kind: "update", isCheckOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument === "--check") update.isCheckOnly = true;
    else return { kind: "error", message: `Unknown option ${argument}` };
  }
  return update;
};

export const parseArguments = (argv: string[]): ParsedArguments => {
  if (argv[0] === "update") return parseUpdateArguments(argv.slice(1));
  const run: RunArguments = { kind: "run", shouldOpenBrowser: true, shouldAutoUpdate: true };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument === "--version" || argument === "-v") return { kind: "version" };
    if (argument === "--no-open") run.shouldOpenBrowser = false;
    else if (argument === "--offline") run.offline = true;
    else if (argument === "--no-auto-update") run.shouldAutoUpdate = false;
    else if (argument === "--port") {
      const port = portOf(argv[++index]);
      if (port === undefined) return { kind: "error", message: `--port needs a number between 1 and ${MAX_PORT}` };
      run.port = port;
    } else if (argument === "--data-dir") {
      const directory = argv[++index];
      if (!directory) return { kind: "error", message: "--data-dir needs a folder" };
      run.dataDirectory = directory;
    } else return { kind: "error", message: `Unknown option ${argument}` };
  }
  return run;
};
