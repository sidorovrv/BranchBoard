import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_NAME, VERSION_PATTERN } from "@branchboard/core";

import manifest from "../../cli/package.json" with { type: "json" };

export const VERSION = manifest.version;

export const installedVersionOf = (webRoot: string | undefined): string | undefined => {
  if (!webRoot) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(webRoot)), "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    return manifest.name === PACKAGE_NAME && typeof manifest.version === "string" && VERSION_PATTERN.test(manifest.version) ? manifest.version : undefined;
  } catch {
    return undefined;
  }
};
