export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export interface PermissionPreset {
  id: string;
  name: string;
  rules: PermissionRule[];
}

const READ_ACTIONS = ["read", "glob", "grep"];
const EDIT_ACTIONS = ["edit"];
const RUN_ACTIONS = ["shell", "subagent", "skill", "question", "webfetch", "websearch", "external_directory", "execute"];

const rulesFor = (actions: string[], effect: PermissionEffect): PermissionRule[] => actions.map((action) => ({ action, resource: "*", effect }));

const SECRET_READ_RULE: PermissionRule = { action: "read", resource: "*.env", effect: "deny" };

export const PERMISSION_PRESETS: PermissionPreset[] = [
  { id: "manual", name: "Manual", rules: [...rulesFor(READ_ACTIONS, "allow"), SECRET_READ_RULE, ...rulesFor([...EDIT_ACTIONS, ...RUN_ACTIONS.filter((action) => action !== "question")], "ask"), ...rulesFor(["question"], "allow")] },
  { id: "plan", name: "Plan", rules: [...rulesFor(READ_ACTIONS, "allow"), SECRET_READ_RULE, ...rulesFor(EDIT_ACTIONS, "deny"), ...rulesFor(["question"], "allow"), ...rulesFor(["shell", "webfetch", "websearch", "subagent", "skill"], "ask")] },
  { id: "acceptEdits", name: "Accept edits", rules: [...rulesFor([...READ_ACTIONS, ...EDIT_ACTIONS], "allow"), SECRET_READ_RULE, ...rulesFor(["question"], "allow"), ...rulesFor(["shell", "webfetch", "websearch", "subagent", "skill", "external_directory", "execute"], "ask")] },
  { id: "auto", name: "Auto", rules: [...rulesFor([...READ_ACTIONS, ...EDIT_ACTIONS, ...RUN_ACTIONS], "allow"), SECRET_READ_RULE] },
  { id: "dontAsk", name: "Don't ask", rules: [...rulesFor([...READ_ACTIONS, "question"], "allow"), SECRET_READ_RULE, ...rulesFor([...EDIT_ACTIONS, ...RUN_ACTIONS.filter((action) => action !== "question")], "deny")] },
];

export const PERMISSION_MODES = PERMISSION_PRESETS.map(({ id, name }) => ({ id, name }));

export const DEFAULT_PERMISSION_PRESET = "acceptEdits";

export const presetRules = (id: string | undefined): PermissionRule[] | undefined => PERMISSION_PRESETS.find((preset) => preset.id === id)?.rules;
