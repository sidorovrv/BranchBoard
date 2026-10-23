import { create } from "zustand";

const load = (storageKey: string): string[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

const save = (storageKey: string, ids: string[]) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(ids));
  } catch {
    return;
  }
};

interface IdSetStore {
  ids: string[];
  setMember: (id: string, isMember: boolean) => void;
}

export const createPersistedIdSet = (storageKey: string) => {
  const useIdSet = create<IdSetStore>((set, get) => ({
    ids: load(storageKey),
    setMember: (id, isMember) => {
      const others = get().ids.filter((existing) => existing !== id);
      const ids = isMember ? [...others, id] : others;
      save(storageKey, ids);
      set({ ids });
    },
  }));
  return {
    useIds: () => useIdSet((store) => store.ids),
    useMember: (id: string): [boolean, (isMember: boolean) => void] => {
      const isMember = useIdSet((store) => store.ids.includes(id));
      const setMember = useIdSet((store) => store.setMember);
      return [isMember, (value) => setMember(id, value)];
    },
  };
};
