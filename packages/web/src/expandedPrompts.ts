import { create } from "zustand";

const STORAGE_KEY = "branchboard.expandedPrompts";

const load = (): string[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

const save = (nodeIds: string[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nodeIds));
  } catch {
    return;
  }
};

interface ExpandedPromptsStore {
  nodeIds: string[];
  setExpanded: (nodeId: string, isExpanded: boolean) => void;
}

const useExpandedPrompts = create<ExpandedPromptsStore>((set, get) => ({
  nodeIds: load(),
  setExpanded: (nodeId, isExpanded) => {
    const others = get().nodeIds.filter((id) => id !== nodeId);
    const nodeIds = isExpanded ? [...others, nodeId] : others;
    save(nodeIds);
    set({ nodeIds });
  },
}));

export const useExpandedPrompt = (nodeId: string): [boolean, (isExpanded: boolean) => void] => {
  const isExpanded = useExpandedPrompts((store) => store.nodeIds.includes(nodeId));
  const setExpanded = useExpandedPrompts((store) => store.setExpanded);
  return [isExpanded, (value) => setExpanded(nodeId, value)];
};
