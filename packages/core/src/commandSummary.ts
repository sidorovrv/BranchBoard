export const SENSITIVE_COMMANDS: ReadonlySet<string> = new Set(["setCredential", "answerRequest"]);

const SUMMARISED_KEYS = ["type", "boardId", "projectId", "nodeId", "nodeIds", "runtimeId"];

export const summariseCommand = (command: Record<string, unknown>): Record<string, unknown> => ({
  ...Object.fromEntries(SUMMARISED_KEYS.filter((key) => key in command).map((key) => [key, command[key]])),
  fields: Object.keys(command).filter((key) => !SUMMARISED_KEYS.includes(key)),
});
