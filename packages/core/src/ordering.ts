export type ListPlacement = "before" | "after";

export const applyOrder = <T extends { id: string }>(items: T[], orderedIds: string[], unlistedGoFirst: boolean): T[] => {
  const listed = items.filter((item) => orderedIds.includes(item.id)).sort((left, right) => orderedIds.indexOf(left.id) - orderedIds.indexOf(right.id));
  const unlisted = items.filter((item) => !orderedIds.includes(item.id));
  return unlistedGoFirst ? [...unlisted, ...listed] : [...listed, ...unlisted];
};

export const moveWithin = (ids: string[], draggedId: string, targetId: string, placement: ListPlacement): string[] => {
  if (draggedId === targetId || !ids.includes(draggedId) || !ids.includes(targetId)) return ids;
  const without = ids.filter((id) => id !== draggedId);
  const targetIndex = without.indexOf(targetId);
  without.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, draggedId);
  return without;
};
