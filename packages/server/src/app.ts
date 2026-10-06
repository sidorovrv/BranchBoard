import { existsSync, readFileSync, statSync } from "node:fs";
import { type Server } from "node:http";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { describeContext, encoders, type Id } from "@branchboard/core";
import { createAttachmentStore, MAX_ATTACHMENT_BYTES } from "./attachments";
import { createCodeFileSync } from "./codeFileSync";
import { createBoardService, RefusedError, SensitiveFilesError } from "./boards";
import { dispatchCommand, type CommandContext } from "./commands";
import { openRepository } from "./db";
import { pickFolder } from "./folderPicker";
import { createHub } from "./hub";
import { currentLogFile, log, readLogTail } from "./log";
import { downloadNameOf, existingWorkspaceFile, searchWorkspaceFiles, servedFileOf } from "./workspaceFiles";
import { createRunLog } from "./runLog";
import { createPerfLog } from "./perfLog";
import { createRunService, type Runtimes } from "./run/pipeline";
import { fakeRuntime } from "./runtimes/fake";
import { createCostStore } from "./costs";
import { createLimitsStore } from "./limits";
import { createClaudeRuntime } from "./runtimes/claude";
import { createApprovalBroker, type ApprovalBroker } from "./runtimes/claudeApprovals";
import { opencodeRuntime } from "./runtimes/opencode";
import { isUpgradeAllowed, noFramingMiddleware, securityMiddleware, type SecurityConfig } from "./security";
import { createTrashService } from "./trash";

export interface AppOptions {
  databasePath: string;
  security: SecurityConfig;
  webRoot?: string;
  runtimes?: Runtimes;
  approvals?: ApprovalBroker;
}

const errorStatus = (error: unknown): 409 | 500 => (error instanceof RefusedError || error instanceof SyntaxError ? 409 : 500);

export const createApp = (options: AppOptions) => {
  const repository = openRepository(options.databasePath);
  const hub = createHub();
  const boards = createBoardService(repository, hub);
  const approvals = options.approvals ?? createApprovalBroker();
  const limitsDirectory = dirname(options.databasePath);
  const limits = options.runtimes ? createLimitsStore() : createLimitsStore(join(limitsDirectory, "limits.json"), join(limitsDirectory, "limits-history.jsonl"));
  const claudeRuntime = createClaudeRuntime({ approvals, limits, serverUrl: `http://127.0.0.1:${options.security.port}` });
  const runtimes: Runtimes = options.runtimes ?? { fake: fakeRuntime, opencode: opencodeRuntime, claude: claudeRuntime };
  const attachments = createAttachmentStore(join(dirname(options.databasePath), "attachments"));
  const runLog = createRunLog(join(dirname(options.databasePath), "run-logs"));
  const perfLog = createPerfLog(join(dirname(options.databasePath), "perf"));
  const costs = createCostStore(options.runtimes ? undefined : join(limitsDirectory, "costs-history.jsonl"));
  const runs = createRunService(boards, runtimes, attachments, runLog, costs);
  boards.recoverInterruptedRuns();
  const codeFileSync = createCodeFileSync(boards);
  const trash = createTrashService(repository, boards, attachments);
  trash.purgeExpired();
  trash.sweepAttachments();
  const context: CommandContext = { boards, runs, runtimes, attachments, trash };

  const app = new Hono();
  app.use("*", noFramingMiddleware);
  app.use("*", securityMiddleware(options.security));
  app.use("*", async (honoContext, next) => {
    perfLog.countRequest(honoContext.req.method, honoContext.req.path);
    await next();
  });
  app.onError((error, honoContext) => {
    const status = errorStatus(error);
    const where = `${honoContext.req.method} ${honoContext.req.path}`;
    if (status === 409) log.warn("http", `Refused ${where}: ${error.message}`);
    else log.error("http", `Failed ${where}: ${error.message}`, error);
    return honoContext.json({ error: error.message, ...(error instanceof SensitiveFilesError ? { sensitiveFiles: error.files } : {}) }, status);
  });

  app.post("/api/commands", async (honoContext) => {
    const command = await honoContext.req.json();
    log.info("command", `${command.type}${command.boardId ? ` board=${command.boardId}` : ""}`, command.type === "importBoard" ? undefined : command);
    return honoContext.json(await dispatchCommand(context, command));
  });
  app.post("/api/perf", async (honoContext) => {
    if (!perfLog.recordWebSample(await honoContext.req.json().catch(() => undefined))) throw new RefusedError("Not a usable performance sample");
    return honoContext.body(null, 204);
  });
  app.post("/mcp/:secret", async (honoContext) => {
    const reply = await approvals.handle(honoContext.req.param("secret"), await honoContext.req.json());
    return reply.body === undefined ? honoContext.body(null, reply.status) : honoContext.json(reply.body, reply.status);
  });
  app.on(["GET", "DELETE"], "/mcp/:secret", (honoContext) => honoContext.body(null, 405));
  app.post("/api/pick-folder", async (honoContext) => {
    log.info("folder-picker", "Opening the system folder dialog");
    const path = (await pickFolder()) ?? null;
    log.info("folder-picker", path ? `Selected ${path}` : "Dialog closed without a selection");
    return honoContext.json({ path });
  });
  app.post("/api/boards/:id/attachments", async (honoContext) => {
    boards.stateOf(honoContext.req.param("id"));
    const declaredSize = Number(honoContext.req.header("content-length") ?? 0);
    if (declaredSize > MAX_ATTACHMENT_BYTES) throw new RefusedError("That file is too large");
    const bytes = new Uint8Array(await honoContext.req.arrayBuffer());
    const attachment = attachments.save(honoContext.req.query("name") ?? "file", honoContext.req.header("content-type") ?? "", bytes);
    log.info("attachment", `Stored ${attachment.name} (${attachment.mime}, ${attachment.size} bytes) as ${attachment.id}`);
    return honoContext.json(attachment);
  });
  app.get("/api/attachments/:id", (honoContext) => {
    const { attachment, bytes } = attachments.read(honoContext.req.param("id"));
    const disposition = attachments.isInline(attachment) ? "inline" : "attachment";
    return honoContext.body(bytes, 200, {
      "content-type": attachments.servedMime(attachment),
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });
  });
  app.get("/api/boards", (honoContext) => honoContext.json(boards.listBoards()));
  app.get("/api/limits", (honoContext) => honoContext.json(limits.current() ?? null));
  app.get("/api/costs", (honoContext) => honoContext.json(costs.lastHour()));
  app.get("/api/runs",(honoContext) => honoContext.json(runs.listRuns()));
  app.get("/api/runs/finished", (honoContext) => honoContext.json(runs.listFinishedRuns()));
  app.get("/api/projects", (honoContext) => honoContext.json(boards.listProjects()));
  app.get("/api/trash", (honoContext) => honoContext.json(trash.list()));
  app.get("/api/workspace/files", (honoContext) => {
    const board = boards.stateOf(honoContext.req.query("board") ?? "").board;
    return honoContext.json(searchWorkspaceFiles(board.workspacePath, honoContext.req.query("q") ?? ""));
  });
  app.get("/api/boards/:id/files", (honoContext) => {
    const board = boards.stateOf(honoContext.req.param("id")).board;
    const path = existingWorkspaceFile(board.workspacePath, honoContext.req.query("path") ?? "");
    if (!path) throw new RefusedError("That file is not in the project folder");
    if (statSync(path).size > MAX_ATTACHMENT_BYTES) throw new RefusedError("That file is too large to open");
    const served = servedFileOf(path);
    return honoContext.body(readFileSync(path), 200, {
      "content-type": served.contentType,
      "content-disposition": `${served.disposition}; filename*=UTF-8''${downloadNameOf(path)}`,
      "x-content-type-options": "nosniff",
      ...(served.policy ? { "content-security-policy": served.policy } : {}),
    });
  });
  app.get("/api/health", async (honoContext) => {
    const requested = honoContext.req.query("runtime");
    const workspaceQuery = honoContext.req.query("workspace");
    const targets = requested
      ? [{ mode: requested as keyof Runtimes, workspacePath: workspaceQuery ?? process.cwd() }]
      : [...new Map(boards.listProjects().filter((project) => project.mode !== "fake").map((project) => [project.mode, { mode: project.mode, workspacePath: project.workspacePath }])).values()];
    const entries = await Promise.all(
      targets.map(async ({ mode, workspacePath }) => {
        const runtime = runtimes[mode];
        if (!runtime) throw new RefusedError(`Unknown runtime ${mode}`);
        const [catalog, diagnostics] = await Promise.all([runs.catalogOf(mode, workspacePath), runtime.diagnostics?.(workspacePath).catch(() => ({}))]);
        return { id: mode, workspacePath, isOk: catalog?.health.ok ?? false, detail: catalog?.health.detail ?? "The runtime did not answer", ...diagnostics };
      }),
    );
    return honoContext.json({ runtimes: entries, logFile: currentLogFile() ?? null });
  });
  app.get("/api/logs", (honoContext) =>
    honoContext.json({ lines: readLogTail(Math.min(1000, Number(honoContext.req.query("tail") ?? 300) || 300), honoContext.req.query("filter") || undefined) }),
  );
  app.get("/api/boards/:id/graph", (honoContext) => {
    const state = boards.stateOf(honoContext.req.param("id"));
    return honoContext.json({ board: state.board, graph: state.graph, parts: state.parts, requests: state.requests, savedAt: state.board.updatedAt });
  });
  app.get("/api/nodes/:id/context", (honoContext) => {
    const state = boards.stateOf(honoContext.req.query("board") ?? "");
    const nodeId = honoContext.req.param("id");
    if (!state.graph.nodes[nodeId]) throw new RefusedError("Node not found");
    return honoContext.json(describeContext(state.graph, state.parts, nodeId));
  });
  app.get("/api/runtime/catalog", async (honoContext) => {
    const boardId = honoContext.req.query("board");
    const board = boardId ? boards.stateOf(boardId).board : undefined;
    const mode = (board?.mode ?? honoContext.req.query("mode") ?? "fake") as keyof Runtimes;
    const runtime = runtimes[mode];
    if (!runtime) throw new RefusedError(`Unknown runtime ${mode}`);
    return honoContext.json(await runtime.catalog(board?.workspacePath ?? honoContext.req.query("workspace") ?? process.cwd()));
  });
  app.get("/api/boards/:id/export", (honoContext) => {
    const document = boards.exportDocument(honoContext.req.param("id"));
    honoContext.header("content-disposition", `attachment; filename="${document.board.title.replace(/[^\w-]+/g, "_")}.branchboard.json"`);
    return honoContext.body(encoders.json(document), 200, { "content-type": "application/json" });
  });

  const { webRoot } = options;
  if (webRoot && existsSync(webRoot)) {
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("*", (honoContext) => honoContext.html(readFileSync(join(webRoot, "index.html"), "utf8")));
  }

  const listen = (port: number, hostname = "127.0.0.1") =>
    new Promise<Server>((resolve, reject) => {
      const server = serve({ fetch: app.fetch, port, hostname }, () => resolve(server as Server)) as Server;
      server.on("error", (error: NodeJS.ErrnoException) => {
        log.error("server", error.code === "EADDRINUSE" ? `Port ${port} is already in use. Stop the other Branchboard or set PORT.` : `Server error: ${error.message}`, error);
        reject(error);
      });
      const sockets = new WebSocketServer({ noServer: true });
      server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const boardId: Id | null = url.pathname === "/api/events" ? url.searchParams.get("board") : null;
        if (!boardId || !isUpgradeAllowed(options.security, request)) {
          log.warn("websocket", `Rejected upgrade ${url.pathname} host=${request.headers.host} origin=${request.headers.origin}`);
          return socket.destroy();
        }
        sockets.handleUpgrade(request, socket, head, (client) => {
          log.debug("websocket", `Client connected to board ${boardId}`);
          const unsubscribe = hub.subscribe(boardId, { send: (message) => client.readyState === client.OPEN && client.send(message) });
          client.on("close", () => {
            log.debug("websocket", `Client left board ${boardId}`);
            unsubscribe();
          });
          client.on("error", (error) => log.error("websocket", `Socket error on board ${boardId}`, error));
        });
      });
    });

  const startPerfSampling = () =>
    perfLog.startServerSampling(() => {
      const { clients, messages } = hub.takeStats();
      return { activeRuns: runs.listRuns().length, socketClients: clients, socketMessages: messages };
    });

  return { app, listen, boards, runs, trash, perfLog, startPerfSampling, codeFileSync, close: () => {
      boards.flushAllParts();
      repository.close();
    } };
};
