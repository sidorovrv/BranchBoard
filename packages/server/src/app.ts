import { existsSync, readFileSync, statSync } from "node:fs";
import { type Server } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import { homedir } from "node:os";
import { describeContext, embedFiles, encoders, hasCredential, isRuntimeId, isSensitivePath, redactSecrets, SENSITIVE_COMMANDS, summariseCommand, updateFor, isNewerVersion, type AboutInfo, type Id } from "@branchboard/core";
import { createAttachmentStore, MAX_ATTACHMENT_BYTES } from "./attachments";
import { BODY_CAPS, commandCapOf, readCappedBody } from "./bodies";
import { createCodeFileSync } from "./codeFileSync";
import { createBoardService, RefusedError, SensitiveFilesError } from "./boards";
import { createTelemetry, type PostPayload } from "./telemetry";
import { createUsage } from "./usage";
import { dispatchCommand, type CommandContext } from "./commands";
import { openRepository } from "./db";
import { pickPath } from "./folderPicker";
import { browseFolder, insideWorkspace } from "./pathBrowser";
import { createHub } from "./hub";
import { currentLogFile, log, readLogTail } from "./log";
import { downloadNameOf, existingWorkspaceFile, PREVIEW_POLICY, previewContentTypeOf, searchWorkspaceFiles, servedFileOf } from "./workspaceFiles";
import { buildReport } from "./report";
import { createRunLog } from "./runLog";
import { createPerfLog } from "./perfLog";
import { createRunService, type Runtimes } from "./run/pipeline";
import { fakeRuntime } from "./runtimes/fake";
import { createCostStore } from "./costs";
import { createLimitsStore } from "./limits";
import { createClaudeRuntime } from "./runtimes/claude";
import { createApprovalBroker, type ApprovalBroker } from "./runtimes/claudeApprovals";
import { createCodexRuntime } from "./runtimes/codex";
import { opencodeRuntime } from "./runtimes/opencodeAuto";
import { opencode2Runtime } from "./runtimes/opencode2";
import { provideServerAddress } from "./runtimes/opencodeServer";
import { createCapabilityStore } from "./capabilities";
import { createCredentialStore } from "./credentials";
import { createEngine } from "./engine/flavor";
import { createEngineInstaller } from "./engine/install";
import { engineRuntime } from "./engine/runtime";
import { createRemoteChannel } from "./channel";
import { dataDirectoryId } from "./dataDirectory";
import { VERSION, installedVersionOf } from "./version";
import { INSTANCE_PATH, isUpgradeAllowed, noFramingMiddleware, securityMiddleware, type SecurityConfig } from "./security";
import { createTrashService } from "./trash";

export interface AppOptions {
  databasePath: string;
  security: SecurityConfig;
  webRoot?: string;
  version?: string;
  runtimes?: Runtimes;
  approvals?: ApprovalBroker;
  telemetryPost?: PostPayload;
  clock?: () => number;
}

const errorStatus = (error: unknown): 409 | 500 => (error instanceof RefusedError || error instanceof SyntaxError ? 409 : 500);

export const createApp = (options: AppOptions) => {
  const currentVersion = options.version ?? VERSION;
  const repository = openRepository(options.databasePath);
  const hub = createHub();
  const limitsDirectory = dirname(options.databasePath);
  const usage = createUsage({ dataDirectory: limitsDirectory, clock: options.clock });
  const boards = createBoardService(repository, hub, usage);
  const approvals = options.approvals ?? createApprovalBroker();
  const limits = options.runtimes ? createLimitsStore() : createLimitsStore(join(limitsDirectory, "limits.json"), join(limitsDirectory, "limits-history.jsonl"));
  const channel = createRemoteChannel({ dataDirectory: limitsDirectory });
  const claudeRuntime = createClaudeRuntime({
    approvals,
    limits: limits.of("claude"),
    serverUrl: `http://127.0.0.1:${options.security.port}`,
    extraModels: () => [...channel.contents().claudeModels, ...channel.seenModels()],
    noteModelSeen: channel.recordSeenModel,
  });
  const credentials = createCredentialStore(limitsDirectory);
  provideServerAddress(credentials.serverAddress);
  const engineInstaller = createEngineInstaller({ dataDirectory: limitsDirectory });
  const engine = createEngine({ dataDirectory: limitsDirectory, installer: engineInstaller, channelContents: channel.contents, credentials });
  const runtimes: Runtimes = options.runtimes ?? {
    fake: fakeRuntime,
    opencode: opencodeRuntime,
    opencode2: opencode2Runtime,
    claude: claudeRuntime,
    codex: createCodexRuntime({ limits: limits.of("codex") }),
    anthropic: engineRuntime("anthropic", { engine, installer: engineInstaller, credentials }),
    openai: engineRuntime("openai", { engine, installer: engineInstaller, credentials }),
  };
  const attachments = createAttachmentStore(join(dirname(options.databasePath), "attachments"));
  const runLog = createRunLog(join(dirname(options.databasePath), "run-logs"));
  const perfLog = createPerfLog(join(dirname(options.databasePath), "perf"));
  const costs = createCostStore(options.runtimes ? undefined : join(limitsDirectory, "costs-history.jsonl"));
  const runs = createRunService(boards, runtimes, attachments, runLog, costs, usage);
  boards.recoverInterruptedRuns();
  const telemetry = createTelemetry({ dataDirectory: limitsDirectory, usage, boards, version: currentVersion, isOffline: () => channel.status().isOffline, post: options.telemetryPost, clock: options.clock });
  const codeFileSync = createCodeFileSync(boards);
  const trash = createTrashService(repository, boards, attachments, (board, references) =>
    references.forEach((reference) => void runtimes[board.mode]?.dropSession?.(reference, board.workspacePath).catch((error) => log.warn("trash", `Could not delete session ${reference.sessionId}`, error))),
  );
  trash.purgeExpired();
  trash.sweepAttachments();
  const capabilities = createCapabilityStore();
  const context: CommandContext = { boards, runs, runtimes, attachments, trash, capabilities, credentials, telemetry, usage, dataDirectory: limitsDirectory, databasePath: options.databasePath };
  const redactionContext = () => ({ secrets: [...(options.security.accessToken ? [options.security.accessToken] : []), ...credentials.secretValues()], homeDirectory: homedir() });

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
    const command = (await readCappedBody(honoContext.req.raw, commandCapOf(honoContext.req.raw), "json")) as Record<string, unknown> & { type: string };
    log.info("command", `${command.type}${command.boardId ? ` board=${command.boardId}` : ""}`, summariseCommand(command));
    if (!SENSITIVE_COMMANDS.has(command.type)) log.debug("command", `${command.type} (full)`, command.type === "importBoard" ? undefined : command);
    return honoContext.json(await dispatchCommand(context, command));
  });
  app.post("/api/perf", async (honoContext) => {
    const sample = await readCappedBody(honoContext.req.raw, BODY_CAPS.perf, "json").catch(() => undefined);
    if (!perfLog.recordWebSample(sample)) throw new RefusedError("Not a usable performance sample");
    return honoContext.body(null, 204);
  });
  app.post("/mcp/:secret", async (honoContext) => {
    const reply = await approvals.handle(honoContext.req.param("secret"), await readCappedBody(honoContext.req.raw, BODY_CAPS.mcp, "json"));
    return reply.body === undefined ? honoContext.body(null, reply.status) : honoContext.json(reply.body, reply.status);
  });
  app.on(["GET", "DELETE"], "/mcp/:secret", (honoContext) => honoContext.body(null, 405));
  app.post("/api/pick-path", async (honoContext) => {
    const kind = honoContext.req.query("kind") === "file" ? "file" : "folder";
    const boardId = honoContext.req.query("board");
    const workspacePath = boardId ? boards.stateOf(boardId).board.workspacePath : undefined;
    log.info("folder-picker", `Opening the system ${kind} dialog`);
    const picked = await pickPath(kind, workspacePath);
    log.info("folder-picker", picked ? `Selected ${picked}` : "Dialog closed without a selection");
    const path = picked && workspacePath && kind === "file" ? insideWorkspace(workspacePath, picked) : (picked ?? null);
    return honoContext.json({ path });
  });
  app.get("/api/browse", (honoContext) => honoContext.json(browseFolder(honoContext.req.query("path"), honoContext.req.query("files") === "1")));
  app.post("/api/boards/:id/attachments", async (honoContext) => {
    boards.stateOf(honoContext.req.param("id"));
    const bytes = await readCappedBody(honoContext.req.raw, BODY_CAPS.attachments, "bytes");
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
  app.get("/api/about", async (honoContext) => {
    if (honoContext.req.query("fresh") === "1") await channel.refresh({ force: true });
    const { tags, minimumVersion } = channel.contents();
    const { checkedAt, error, isOffline } = channel.status();
    const installedVersion = installedVersionOf(options.webRoot);
    const about: AboutInfo = {
      version: currentVersion,
      installedVersion: installedVersion && isNewerVersion(installedVersion, currentVersion) ? installedVersion : null,
      platform: process.platform,
      dataDirectory: limitsDirectory,
      update: updateFor(tags, currentVersion),
      channelVersion: tags.latest ?? null,
      isUnsupported: minimumVersion !== undefined && isNewerVersion(minimumVersion, currentVersion),
      minimumVersion: minimumVersion ?? null,
      isOffline,
      checkedAt,
      checkError: error ?? null,
    };
    return honoContext.json(about);
  });
  app.get("/api/telemetry", async (honoContext) => honoContext.json(await telemetry.overview()));
  app.get(INSTANCE_PATH,(honoContext) => honoContext.json({ app: "branchboard", dataDirId: dataDirectoryId(dirname(options.databasePath)) }));
  app.get("/api/boards", (honoContext) => honoContext.json(boards.listBoards()));
  app.get("/api/limits", (honoContext) => honoContext.json(limits.current(honoContext.req.query("runtime") ?? "claude") ?? null));
  app.get("/api/costs", (honoContext) => honoContext.json(costs.lastHour()));
  app.get("/api/runs",(honoContext) => honoContext.json(runs.listRuns()));
  app.get("/api/runs/finished", (honoContext) => honoContext.json(runs.listFinishedRuns()));
  app.get("/api/projects", (honoContext) => honoContext.json(boards.listProjects()));
  app.get("/api/trash", (honoContext) => honoContext.json(trash.list()));
  app.get("/api/workspace/files", (honoContext) => {
    const board = boards.stateOf(honoContext.req.query("board") ?? "").board;
    return honoContext.json(searchWorkspaceFiles(board.workspacePath, honoContext.req.query("q") ?? ""));
  });
  app.get("/preview/:secret/*", (honoContext) => {
    const boardId = capabilities.resolve("preview", honoContext.req.param("secret"));
    const requested = (() => {
      try {
        return honoContext.req.path.split("/").slice(3).map(decodeURIComponent).join("/");
      } catch {
        return "";
      }
    })();
    const path = boardId && !isSensitivePath(requested) ? existingWorkspaceFile(boards.stateOf(boardId).board.workspacePath, requested) : undefined;
    const contentType = path ? previewContentTypeOf(path) : undefined;
    if (!path || !contentType || statSync(path).size > MAX_ATTACHMENT_BYTES) return honoContext.body(null, 404);
    return honoContext.body(readFileSync(path), 200, {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "x-frame-options": "SAMEORIGIN",
      "content-security-policy": PREVIEW_POLICY,
    });
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
  const workspaceOf = (query: (name: string) => string | undefined): string => {
    const [boardId, projectId, folder] = [query("board"), query("project"), query("workspace")];
    if (boardId) return boards.stateOf(boardId).board.workspacePath;
    if (projectId) {
      const project = boards.listProjects().find((candidate) => candidate.id === projectId);
      if (!project) throw new RefusedError("That project no longer exists");
      return project.workspacePath;
    }
    if (folder === undefined) return process.cwd();
    if (!isAbsolute(folder) || /^[\\/]{2}/.test(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) throw new RefusedError("That is not an existing local folder");
    return folder;
  };
  const collectHealth = async (requested?: string, workspacePath?: string, isFresh = false) => {
    const targets = requested
      ? [{ mode: requested as keyof Runtimes, workspacePath: workspacePath ?? process.cwd() }]
      : [...new Map(boards.listProjects().filter((project) => project.mode !== "fake").map((project) => [project.mode, { mode: project.mode, workspacePath: project.workspacePath }])).values()];
    const entries = await Promise.all(
      targets.map(async ({ mode, workspacePath }) => {
        const runtime = runtimes[mode];
        if (!runtime) throw new RefusedError(`Unknown runtime ${mode}`);
        const [catalog, diagnostics] = await Promise.all([runs.catalogOf(mode, workspacePath, isFresh), runtime.diagnostics?.(workspacePath).catch(() => ({}))]);
        const processSlots = runtime.slots && { active: runtime.slots.activeCount(), limit: runtime.slots.limit, waiting: runtime.slots.waitingCount() };
        return { id: mode, workspacePath, isOk: catalog?.health.ok ?? false, detail: catalog?.health.detail ?? "The runtime did not answer", credential: catalog?.credential, processSlots, ...diagnostics };
      }),
    );
    return { runtimes: entries, logFile: currentLogFile() ?? null, version: currentVersion, dataDirectory: limitsDirectory };
  };
  app.get("/api/health", async (honoContext) => honoContext.json(await collectHealth(honoContext.req.query("runtime"), workspaceOf((name) => honoContext.req.query(name)), honoContext.req.query("fresh") === "1")));
  app.get("/api/report", async (honoContext) => {
    const projects = boards.listProjects();
    const report = buildReport({
      dataDirectory: limitsDirectory,
      version: currentVersion,
      health: await collectHealth(),
      counts: { projects: projects.length, boards: boards.listBoards().length },
      redaction: redactionContext(),
    });
    honoContext.header("content-disposition", `attachment; filename="branchboard-report-${new Date().toISOString().slice(0, 10)}.json"`);
    return honoContext.body(JSON.stringify(report, null, 2), 200, { "content-type": "application/json" });
  });
  app.get("/api/logs", (honoContext) => {
    const lines = readLogTail(Math.min(1000, Number(honoContext.req.query("tail") ?? 300) || 300), honoContext.req.query("filter") || undefined);
    return honoContext.json({ lines: lines.map((line) => redactSecrets(line, redactionContext())) });
  });
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
    if (honoContext.req.query("fresh") === "1") {
      await runtime.forgetCaches?.();
      runs.forgetCatalogs();
    }
    return honoContext.json(await runtime.catalog(workspaceOf((name) => honoContext.req.query(name))));
  });
  app.get("/api/runtime/credential", (honoContext) => {
    const mode = honoContext.req.query("mode") ?? "";
    if (!isRuntimeId(mode) || !hasCredential(mode)) throw new RefusedError(`The ${mode} runtime has no saved credential`);
    return honoContext.json(credentials.status(mode));
  });
  const panelsOf = (honoContext: { req: { query(name: string): string | undefined } }) => {
    const mode = (honoContext.req.query("mode") ?? "fake") as keyof Runtimes;
    const runtime = runtimes[mode];
    if (!runtime?.panels || !runtime.panelAction) throw new RefusedError(`The ${mode} runtime shows no details`);
    return { runtime: { panels: runtime.panels, panelAction: runtime.panelAction }, workspacePath: workspaceOf((name) => honoContext.req.query(name)) };
  };
  app.get("/api/runtime/panels", async (honoContext) => {
    const { runtime, workspacePath } = panelsOf(honoContext);
    return honoContext.json({ panels: await runtime.panels(workspacePath) });
  });
  app.post("/api/runtime/panels/:panel/:row/:action", async (honoContext) => {
    const { runtime, workspacePath } = panelsOf(honoContext);
    const { panel, row, action } = honoContext.req.param();
    await runtime.panelAction(panel, row, action, workspacePath);
    return honoContext.json({ ok: true });
  });
  app.get("/api/boards/:id/export", (honoContext) => {
    const plain = boards.exportDocument(honoContext.req.param("id"));
    const document = (() => {
      try {
        return honoContext.req.query("files") === "0" ? plain : embedFiles(plain, { sizeOf: attachments.sizeOf, read: attachments.asDocumentFile });
      } catch (error) {
        throw new RefusedError(error instanceof Error ? error.message : String(error));
      }
    })();
    honoContext.header("content-disposition", `attachment; filename="${document.board.title.replace(/[^\w-]+/g, "_")}.branchboard.json"`);
    return honoContext.body(encoders.json(document), 200, { "content-type": "application/json" });
  });

  const { webRoot } = options;
  if (webRoot && existsSync(webRoot)) {
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("*", (honoContext) => honoContext.html(readFileSync(join(webRoot, "index.html"), "utf8")));
  }

  const openClients = new Set<WebSocket>();

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
          openClients.add(client);
          client.on("close", () => {
            openClients.delete(client);
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

  return { app, listen, boards, runs, trash, perfLog, channel, telemetry, usage, startPerfSampling, codeFileSync, close: () => {
      openClients.forEach((client) => client.terminate());
      void engine.pool.stopAll();
      boards.flushPartsAndStopSaving();
      repository.close();
    } };
};
