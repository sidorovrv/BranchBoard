import { chmodSync } from "node:fs";
import { join } from "node:path";

export const fakeCodexPath = (): string => {
  chmodSync(join(import.meta.dirname, "fake-codex.mjs"), 0o755);
  return join(import.meta.dirname, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex.mjs");
};
