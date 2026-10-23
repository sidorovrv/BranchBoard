import { fileURLToPath } from "node:url";

export type InstallKind = "npm" | "npx" | "source";

export const installKindOf = (modulePath: string): InstallKind => (/[\\/]_npx[\\/]/.test(modulePath) ? "npx" : /[\\/]node_modules[\\/]/.test(modulePath) ? "npm" : "source");

export const currentInstallKind = (): InstallKind => installKindOf(fileURLToPath(import.meta.url));
