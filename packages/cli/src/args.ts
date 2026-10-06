export interface RunArguments {
  kind: "run";
  port?: number;
  dataDirectory?: string;
  shouldOpenBrowser: boolean;
}

export type ParsedArguments = RunArguments | { kind: "help" } | { kind: "version" } | { kind: "error"; message: string };

const MAX_PORT = 65535;

const portOf = (text: string | undefined): number | undefined => {
  const port = Number(text);
  return text !== undefined && Number.isInteger(port) && port >= 1 && port <= MAX_PORT ? port : undefined;
};

export const parseArguments = (argv: string[]): ParsedArguments => {
  const run: RunArguments = { kind: "run", shouldOpenBrowser: true };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument === "--version" || argument === "-v") return { kind: "version" };
    if (argument === "--no-open") run.shouldOpenBrowser = false;
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
