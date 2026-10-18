import { create } from "zustand";
import { applyBoardEvent, describeSensitiveFiles, emptyView, liveNodes, preferredModelId, preferredPermissionMode, sameMembers, unique, type Board, type BoardEvent, type BoardView, type Catalog, type Id, type Project, type RunInfo } from "@branchboard/core";
import { useSettings } from "./settings";
import { recordBoardOpen } from "./boardOpenTiming";
import { CommandRefused, fetchBoards, fetchProjects, fetchTimedBoardView, fetchCatalog, fetchFinishedRuns, fetchRuns, sendCommand, subscribeToBoard } from "./api";

const RUN_POLL_MS = 1500;

const roundMs = (value: number): number => Math.round(value * 10) / 10;

const afterNextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

interface BoardStore {
  runs: RunInfo[];
  finishedRuns: RunInfo[];
  startRunPolling: () => () => void;
  boards: Board[];
  projects: Project[];
  board?: Board;
  view: BoardView;
  catalog?: Catalog;
  selectedIds: Id[];
  toast?: { message: string; id: number };
  pendingFocus?: Id;
  pendingSelection?: Id[];
  requestSelection: (ids: Id[] | undefined) => void;
  isSearchOpen: boolean;
  isReaderOpen: boolean;
  setReaderOpen: (isOpen: boolean) => void;
  isSettingsOpen: boolean;
  settingsSectionId?: string;
  setSettingsOpen: (isOpen: boolean, sectionId?: string) => void;
  isShortcutsOpen: boolean;
  setShortcutsOpen: (isOpen: boolean) => void;
  isBoardLoading: boolean;
  isTourOpen: boolean;
  tourReturnBoardId?: Id;
  beginTour: (sample: { board: Board; view: BoardView }) => void;
  endTour: () => Promise<void>;
  focusNode: (id: Id) => void;
  registerFocus: (focus: (id: Id) => void) => void;
  loadBoards: () => Promise<void>;
  openBoard: (boardId: Id) => Promise<void>;
  send: <T = any>(command: Record<string, unknown>) => Promise<T | undefined>;
  notify: (message: string) => void;
  select: (ids: Id[]) => void;
  setSearchOpen: (isOpen: boolean) => void;
  requestFocus: (id: Id | undefined) => void;
}

const sendAfterConfirmation = async (command: Record<string, unknown>, files: string[]) => {
  if (!confirm(describeSensitiveFiles(files))) return undefined;
  try {
    return await sendCommand({ ...command, allowSensitive: true });
  } catch (error) {
    useBoard.getState().notify(error instanceof Error ? error.message : String(error));
    return undefined;
  }
};

let pendingEvents: BoardEvent[] = [];
let isFlushScheduled = false;
let unsubscribe: (() => void) | undefined;
let focusHandler: (id: Id) => void = () => undefined;

export const useBoard = create<BoardStore>((set, get) => {
  const flushEvents = () => {
    isFlushScheduled = false;
    const batch = pendingEvents;
    pendingEvents = [];
    const renamed = batch.filter((event): event is Extract<BoardEvent, { type: "board" }> => event.type === "board").at(-1)?.board;
    set((state) => ({
      view: batch.reduce(applyBoardEvent, state.view),
      ...(renamed && state.board?.id === renamed.id ? { board: renamed, boards: state.boards.map((candidate) => (candidate.id === renamed.id ? renamed : candidate)) } : {}),
    }));
    if ((renamed?.hasUnseenResult || renamed?.hitUsageLimit) && get().board?.id === renamed.id) void get().send({ type: "markBoardSeen", boardId: renamed.id });
  };

  const queueEvent = (event: BoardEvent) => {
    pendingEvents.push(event);
    if (!isFlushScheduled) {
      isFlushScheduled = true;
      requestAnimationFrame(flushEvents);
    }
  };

  const reload = async (boardId: Id) => {
    const startedAt = performance.now();
    const { body, fetchMs, parseMs } = await fetchTimedBoardView(boardId);
    const { board, ...view } = body;
    pendingEvents = [];
    const renderStartedAt = performance.now();
    set({ board, view });
    void afterNextPaint().then(() => {
      const finishedAt = performance.now();
      recordBoardOpen({ fetchMs: roundMs(fetchMs), parseMs: roundMs(parseMs), renderMs: roundMs(finishedAt - renderStartedAt), totalMs: roundMs(finishedAt - startedAt), nodes: liveNodes(view.graph).length });
    });
  };

  const subscribeAndLoad = (boardId: Id) =>
    new Promise<void>((resolve, reject) => {
      let isFirstOpen = true;
      unsubscribe = subscribeToBoard(boardId, queueEvent, () => {
        const loading = reload(boardId);
        if (!isFirstOpen) return void loading;
        isFirstOpen = false;
        loading.then(resolve, reject);
      });
    });

  const activeBoardKey = (runs: RunInfo[]) => unique(runs.map((run) => run.boardId)).sort().join(",");

  return {
    runs: [],
    finishedRuns: [],
    startRunPolling: () => {
      let isCancelled = false;
      const refresh = async () => {
        try {
          const [runs, finishedRuns] = await Promise.all([fetchRuns(), fetchFinishedRuns()]);
          if (isCancelled) return;
          const hasChanged = activeBoardKey(runs) !== activeBoardKey(get().runs);
          set({ runs, finishedRuns });
          if (hasChanged) await get().loadBoards();
        } catch {
          return;
        }
      };
      void refresh();
      const timer = setInterval(() => void refresh(), RUN_POLL_MS);
      return () => {
        isCancelled = true;
        clearInterval(timer);
      };
    },
    boards: [],
    projects: [],
    view: emptyView(),
    selectedIds: [],
    isSearchOpen: false,
    isReaderOpen: false,
    setReaderOpen: (isOpen) => set({ isReaderOpen: isOpen }),
    isSettingsOpen: false,
    setSettingsOpen: (isOpen, sectionId) => set({ isSettingsOpen: isOpen, settingsSectionId: sectionId }),
    isShortcutsOpen: false,
    setShortcutsOpen: (isOpen) => set({ isShortcutsOpen: isOpen }),
    isBoardLoading: true,
    isTourOpen: false,
    beginTour: (sample) => {
      if (get().isTourOpen) return;
      const tourReturnBoardId = get().board?.id;
      unsubscribe?.();
      unsubscribe = undefined;
      pendingEvents = [];
      set({ board: sample.board, view: sample.view, selectedIds: [], catalog: undefined, isTourOpen: true, tourReturnBoardId });
    },
    endTour: async () => {
      const { tourReturnBoardId } = get();
      set({ isTourOpen: false, tourReturnBoardId: undefined, selectedIds: [] });
      if (tourReturnBoardId) return get().openBoard(tourReturnBoardId);
      set({ board: undefined, view: emptyView(), catalog: undefined });
    },
    focusNode: (id) => focusHandler(id),
    registerFocus: (focus) => (focusHandler = focus),
    loadBoards: async () => {
      const [boards, projects] = await Promise.all([fetchBoards(), fetchProjects()]);
      set({ boards, projects });
    },
    openBoard: async (boardId) => {
      unsubscribe?.();
      set({ selectedIds: [], catalog: undefined, isBoardLoading: true });
      try {
        await subscribeAndLoad(boardId);
      } finally {
        set({ isBoardLoading: false });
      }
      const opened = get().board;
      if (opened?.hasUnseenResult || opened?.hitUsageLimit) {
        set({ board: { ...opened, hasUnseenResult: false, hitUsageLimit: false } });
        await get().send({ type: "markBoardSeen", boardId });
        await get().loadBoards();
      }
      set({ catalog: await fetchCatalog(boardId) });
      localStorage.setItem("branchboard.lastBoard", boardId);
    },
    send: async (command) => {
      if (get().isTourOpen) return undefined;
      try {
        return await sendCommand(command);
      } catch (error) {
        if (error instanceof CommandRefused && error.sensitiveFiles.length > 0) return sendAfterConfirmation(command, error.sensitiveFiles);
        get().notify(error instanceof Error ? error.message : String(error));
        return undefined;
      }
    },
    notify: (message) => set({ toast: { message, id: Date.now() } }),
    select: (ids) => set((state) => (sameMembers(state.selectedIds, ids) ? state : { selectedIds: ids })),
    setSearchOpen: (isOpen) => set({ isSearchOpen: isOpen }),
    requestFocus: (id) => set({ pendingFocus: id }),
    requestSelection: (ids) => set({ pendingSelection: ids }),
  };
});

export const boardId = (): Id => useBoard.getState().board?.id ?? "";

const NODE_CREATING_COMMANDS = ["reply", "note", "file", "code", "extractFile", "extractAttachment"];

let viewCentreHandler: () => { x: number; y: number } | undefined = () => undefined;

export const registerViewCentre = (handler: () => { x: number; y: number } | undefined) => {
  viewCentreHandler = handler;
};

export const currentViewCentre = () => viewCentreHandler();

const isUnconnectedSeed = (command: Record<string, unknown>): boolean => {
  const hasParents = Array.isArray(command.parentIds) && command.parentIds.length > 0;
  return !hasParents && !command.originId && !command.originalId && !command.position;
};

const nearViewFor = (command: Record<string, unknown>): Record<string, unknown> => {
  const centre = isUnconnectedSeed(command) ? viewCentreHandler() : undefined;
  return centre ? { nearPosition: centre } : {};
};

const isTopLevelReply = (command: Record<string, unknown>): boolean => command.type === "reply" && Array.isArray(command.parentIds) && command.parentIds.length === 0;

const preferredModelFor = (command: Record<string, unknown>): Record<string, unknown> => {
  const catalog = useBoard.getState().catalog;
  const models = catalog?.models ?? [];
  const isNewChat = isTopLevelReply(command) && command.model === undefined;
  const model = isNewChat ? (preferredModelId(models, useSettings.getState().settings.defaultModel) ?? models.find((candidate) => candidate.id === catalog?.defaultModel)?.id) : undefined;
  const agent = isNewChat && command.agent === undefined && catalog?.defaultAgent && catalog.agents.includes(catalog.defaultAgent) ? catalog.defaultAgent : undefined;
  return { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
};

const preferredPermissionModeFor = (command: Record<string, unknown>): Record<string, unknown> => {
  const modes = useBoard.getState().catalog?.permissionModes ?? [];
  const permissionMode = isTopLevelReply(command) && command.permissionMode === undefined ? preferredPermissionMode(modes, useSettings.getState().settings.defaultPermissionMode) : undefined;
  return permissionMode ? { permissionMode } : {};
};

const defaultsFor = (command: Record<string, unknown>): Record<string, unknown> =>
  NODE_CREATING_COMMANDS.includes(String(command.type))
    ? { width: useSettings.getState().settings.defaultNodeWidth, height: useSettings.getState().settings.defaultNodeHeight, flowDirection: useSettings.getState().settings.flowDirection, ...nearViewFor(command), ...preferredModelFor(command), ...preferredPermissionModeFor(command) }
    : {};

export const sendBoardCommand = <T = any>(command: Record<string, unknown>) => useBoard.getState().send<T>({ boardId: boardId(), ...defaultsFor(command), ...command });
