import { BRANCH_TITLE_SEPARATOR } from "./graph";

export interface NodeTint {
  hue: number;
  tone: number;
}

const ROOT_HUES = [18, 42, 78, 128, 162, 188, 212, 240, 268, 298, 328, 352];
const BRANCH_HUE_SHIFTS = [-26, -13, 13, 26];
const BRANCH_TONES = [-3, 0, 3];

const hashOf = (text: string): number => {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  return hash;
};

const normalised = (text: string): string => text.trim().toLowerCase();

export const nodeTintOf = (title: string): NodeTint => {
  const [root, ...branch] = title.split(BRANCH_TITLE_SEPARATOR);
  const hue = ROOT_HUES[hashOf(normalised(root)) % ROOT_HUES.length];
  if (branch.length === 0) return { hue, tone: 0 };
  const branchHash = hashOf(normalised(branch.join(BRANCH_TITLE_SEPARATOR)));
  return {
    hue: (hue + BRANCH_HUE_SHIFTS[branchHash % BRANCH_HUE_SHIFTS.length] + 360) % 360,
    tone: BRANCH_TONES[Math.floor(branchHash / BRANCH_HUE_SHIFTS.length) % BRANCH_TONES.length],
  };
};
