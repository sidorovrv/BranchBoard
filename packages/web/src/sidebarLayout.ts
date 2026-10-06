import { create } from "zustand";

const STORAGE_KEY = "branchboard.sidebarLayout";

interface SidebarLayout {
  collapsedProjectIds: string[];
  projectOrder: string[];
  boardOrder: Record<string, string[]>;
  openTabIds: string[];
}

const EMPTY_LAYOUT: SidebarLayout = { collapsedProjectIds: [], projectOrder: [], boardOrder: {}, openTabIds: [] };

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

const load = (): SidebarLayout => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const boardOrder: Record<string, string[]> = {};
    Object.entries(stored.boardOrder ?? {}).forEach(([projectId, ids]) => {
      if (isStringList(ids)) boardOrder[projectId] = ids;
    });
    return {
      collapsedProjectIds: isStringList(stored.collapsedProjectIds) ? stored.collapsedProjectIds : [],
      projectOrder: isStringList(stored.projectOrder) ? stored.projectOrder : [],
      boardOrder,
      openTabIds: isStringList(stored.openTabIds) ? stored.openTabIds : [],
    };
  } catch {
    return EMPTY_LAYOUT;
  }
};

const save = (layout: SidebarLayout) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    return;
  }
};

interface SidebarLayoutStore extends SidebarLayout {
  toggleCollapsed: (projectId: string) => void;
  setProjectOrder: (ids: string[]) => void;
  setBoardOrder: (projectId: string, ids: string[]) => void;
  openTab: (boardId: string) => void;
  closeTab: (boardId: string) => void;
}

export const useSidebarLayout = create<SidebarLayoutStore>((set, get) => {
  const commit = (changes: Partial<SidebarLayout>) => {
    const { collapsedProjectIds, projectOrder, boardOrder, openTabIds } = { ...get(), ...changes };
    save({ collapsedProjectIds, projectOrder, boardOrder, openTabIds });
    set(changes);
  };
  return {
    ...load(),
    toggleCollapsed: (projectId) => {
      const { collapsedProjectIds } = get();
      commit({ collapsedProjectIds: collapsedProjectIds.includes(projectId) ? collapsedProjectIds.filter((id) => id !== projectId) : [...collapsedProjectIds, projectId] });
    },
    setProjectOrder: (projectOrder) => commit({ projectOrder }),
    setBoardOrder: (projectId, ids) => commit({ boardOrder: { ...get().boardOrder, [projectId]: ids } }),
    openTab: (boardId) => {
      if (!get().openTabIds.includes(boardId)) commit({ openTabIds: [...get().openTabIds, boardId] });
    },
    closeTab: (boardId) => commit({ openTabIds: get().openTabIds.filter((id) => id !== boardId) }),
  };
});
