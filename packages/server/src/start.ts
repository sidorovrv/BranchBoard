import { join } from "node:path";
import { accessLinkOf, loadAccessToken } from "./accessToken";
import { createApp } from "./app";
import { firstExisting } from "./dataDirectory";
import { configureLogFile, log } from "./log";

export const DEFAULT_PORT = 4777;

export interface StartOptions {
  port: number;
  dataDirectory: string;
  webRoot?: string;
  extraOrigins?: string[];
}

export interface StartedServer {
  port: number;
  accessLink: string;
}

export const installProcessHandlers = () => {
  process.on("uncaughtException", (error) => log.error("process", "Uncaught exception", error));
  process.on("unhandledRejection", (reason) => log.error("process", "Unhandled promise rejection", reason));
  process.on("warning", (warning) => log.warn("process", `${warning.name}: ${warning.message}`));
  process.on("exit", (code) => log.info("process", `Exiting with code ${code}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      log.info("process", `Received ${signal}, shutting down`);
      process.exit(0);
    });
};

export const startServer = async ({ port, dataDirectory, webRoot, extraOrigins = [] }: StartOptions): Promise<StartedServer> => {
  const databasePath = firstExisting([join(dataDirectory, "branchboard.db"), join(dataDirectory, "wanderboard.db")]);
  configureLogFile(join(dataDirectory, "logs", "server.log"));
  log.info("startup", `Node ${process.version} on ${process.platform}, cwd ${process.cwd()}`);
  log.info("startup", `Database: ${databasePath}`);
  log.info("startup", `Log level: ${process.env.BRANCHBOARD_LOG_LEVEL ?? "debug"} (set BRANCHBOARD_LOG_LEVEL to debug, info, warn or error)`);
  const accessToken = loadAccessToken(join(dataDirectory, "access-token"));
  const { listen, startPerfSampling, perfLog, codeFileSync } = createApp({ databasePath, webRoot, security: { port, extraOrigins, accessToken } });
  await listen(port);
  startPerfSampling();
  codeFileSync.start();
  log.info("startup", `Performance samples: ${perfLog.file}`);
  log.info("startup", "Branchboard is running");
  return { port, accessLink: accessLinkOf(port, accessToken) };
};
