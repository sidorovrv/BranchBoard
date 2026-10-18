import type { GraphNode, Part, RollSnapshot, RuntimeRef } from "./types";

const FIRST_ROLL = 1;
const NO_ROLL = 0;

const SNAPSHOT_FIELDS = ["status", "runtimeRef", "compactedAt", "contextHash", "contextNodeIds", "contextMode", "usage", "stopped", "startedAt", "completedAt", "workspaceSnapshot", "fileHashes", "reverted"] as const;

const hasLegacyRun = (node: GraphNode): boolean => node.runtimeRef !== undefined || node.completedAt !== undefined;

export const activeRollOf = (node: GraphNode): number => node.activeRoll ?? FIRST_ROLL;

export const rollCountOf = (node: GraphNode): number => node.rollCount ?? (hasLegacyRun(node) ? FIRST_ROLL : NO_ROLL);

export const partRollOf = (part: Part): number => part.roll ?? FIRST_ROLL;

export const partsOfRoll = (parts: Part[] | undefined, roll: number): Part[] => (parts ?? []).filter((part) => partRollOf(part) === roll);

const hasLiveRoll = (node: GraphNode): boolean => activeRollOf(node) !== NO_ROLL && rollCountOf(node) > 0;

export const rollNumbersOf = (node: GraphNode): number[] =>
  [...new Set([...(hasLiveRoll(node) ? [activeRollOf(node)] : []), ...Object.keys(node.rolls ?? {}).map(Number)])].sort((left, right) => left - right);

const snapshotOf = (node: GraphNode): RollSnapshot => ({
  ...(Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, node[field]])) as unknown as RollSnapshot),
  status: node.status === "idle" ? "done" : node.status,
});

const rollsWithActive = (node: GraphNode): Record<number, RollSnapshot> => ({
  ...node.rolls,
  ...(hasLiveRoll(node) ? { [activeRollOf(node)]: snapshotOf(node) } : {}),
});

export const rollPatchForQueue = (node: GraphNode): Partial<GraphNode> => {
  const next = rollCountOf(node) + 1;
  return { status: "queued", startedAt: undefined, completedAt: undefined, rolls: rollsWithActive(node), activeRoll: next, rollCount: next };
};

export const rollPatchForSelect = (node: GraphNode, roll: number): Partial<GraphNode> => {
  const rolls = rollsWithActive(node);
  const target = rolls[roll];
  delete rolls[roll];
  const restored = Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, target[field]]));
  return { ...restored, rolls, activeRoll: roll, rollCount: rollCountOf(node), rev: node.rev + 1 };
};

export const rollPatchForDiscard = (node: GraphNode): Partial<GraphNode> =>
  rollCountOf(node) === 0 ? {} : { rolls: {}, activeRoll: NO_ROLL, rollCount: rollCountOf(node), comments: [] };

export const sessionReferencesOf = (nodes: GraphNode[]): RuntimeRef[] => {
  const references = nodes.flatMap((node) => [node.runtimeRef, ...Object.values(node.rolls ?? {}).map((roll) => roll.runtimeRef)]);
  return [...new Map(references.filter((reference): reference is RuntimeRef => reference !== undefined).map((reference) => [reference.sessionId, reference])).values()];
};

export const canSelectRoll = (node: GraphNode, roll: number): boolean => roll !== activeRollOf(node) && node.rolls?.[roll] !== undefined;
