import { join } from "node:path";
import { accessLinkOf, loadAccessToken } from "./accessToken";
import { createApp } from "./app";
import { LISTEN_ALL_ADDRESSES, networkNamesOfThisComputer } from "./security";
import { firstExisting } from "./dataDirectory";
import { withLoopbackDirect } from "./runtimes/spawnProcess";
import { configureLogFile, DEFAULT_CONSOLE_LEVEL, log } from "./log";

export const DEFAULT_PORT = 4777;
const CHANNEL_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 3000;

export interface StartOptions {
  port: number;
  dataDirectory: string;
  webRoot?: string;
  extraOrigins?: string[];
  isOnNetwork?: boolean;
  isKeyless?: boolean;
}

export interface StartedServer {
  port: number;
  accessLink: string;
  networkLinks: string[];
  stop: () => Promise<void>;
}

let stopRunningServer: (() => Promise<void>) | undefined;

export const shutDown = async (reason: string) => {
  log.info("process", `${reason}, shutting down`);
  const stopping = stopRunningServer;
  stopRunningServer = undefined;
  try {
    if (stopping) await Promise.race([stopping(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref())]);
  } catch (error) {
    log.error("process", "Could not stop the server cleanly", error);
  }
  process.exit(0);
};

export const installProcessHandlers = () => {
  process.on("uncaughtException", (error) => log.error("process", "Uncaught exception", error));
  process.on("unhandledRejection", (reason) => log.error("process", "Unhandled promise rejection", reason));
  process.on("warning", (warning) => log.warn("process", `${warning.name}: ${warning.message}`));
  process.on("exit", (code) => log.info("process", `Exiting with code ${code}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutDown(`Received ${signal}`));
};

export const startServer = async ({ port, dataDirectory, webRoot, extraOrigins = [], isOnNetwork = false, isKeyless = false }: StartOptions): Promise<StartedServer> => {
  const databasePath = firstExisting([join(dataDirectory, "branchboard.db"), join(dataDirectory, "wanderboard.db")]);
  configureLogFile(join(dataDirectory, "logs", "server.log"));
  log.info("startup", `Node ${process.version} on ${process.platform}, cwd ${process.cwd()}`);
  log.info("startup", `Database: ${databasePath}`);
  log.info("startup", `Console log level: ${process.env.BRANCHBOARD_LOG_LEVEL ?? DEFAULT_CONSOLE_LEVEL} (set BRANCHBOARD_LOG_LEVEL to debug, info, warn or error)`);
  Object.assign(process.env, withLoopbackDirect(process.env));
  const accessToken = isKeyless ? undefined : loadAccessToken(join(dataDirectory, "access-token"));
  const networkNames = isOnNetwork ? networkNamesOfThisComputer() : [];
  const { listen, startPerfSampling, perfLog, codeFileSync, channel, telemetry, close } = createApp({ databasePath, webRoot, security: { port, extraOrigins, accessToken, networkNames } });
  const server = await listen(port, isOnNetwork ? LISTEN_ALL_ADDRESSES : undefined);
  if (isOnNetwork) log.info("startup", `Listening on the local network as ${networkNames.join(", ")}`);
  if (isKeyless) log.warn("startup", "Access key is off");
  const stopPerfSampling = startPerfSampling();
  const stopCodeFileSync = codeFileSync.start();
  void channel.refresh();
  void telemetry.sendPendingDays();
  const channelTimer = setInterval(() => {
    void channel.refresh();
    void telemetry.sendPendingDays();
  }, CHANNEL_CHECK_INTERVAL_MS);
  channelTimer.unref();
  log.info("startup", `Performance samples: ${perfLog.file}`);
  log.info("startup", "Branchboard is running");
  const stop = async () => {
    stopPerfSampling();
    stopCodeFileSync();
    clearInterval(channelTimer);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    close();
    server.closeAllConnections();
    await closed;
  };
  stopRunningServer = stop;
  return { port, accessLink: accessLinkOf(port, accessToken), networkLinks: networkNames.map((name) => accessLinkOf(port, accessToken, name)), stop };
};
