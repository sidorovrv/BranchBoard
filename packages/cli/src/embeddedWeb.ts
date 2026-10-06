import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAsset, getRawAsset } from "node:sea";

export const WEB_MANIFEST_ASSET = "web-manifest.json";
export const webAssetName = (relativePath: string): string => `web/${relativePath}`;

export interface WebManifest {
  id: string;
  files: string[];
}

export const readWebManifest = (): WebManifest => JSON.parse(getAsset(WEB_MANIFEST_ASSET, "utf8"));

export const extractEmbeddedWeb = (webDirectoryOf: (id: string) => string): string => {
  const manifest = readWebManifest();
  const target = webDirectoryOf(manifest.id);
  if (existsSync(join(target, "index.html"))) return target;
  const staging = `${target}.partial`;
  rmSync(staging, { recursive: true, force: true });
  manifest.files.forEach((relativePath) => {
    const destination = join(staging, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, new Uint8Array(getRawAsset(webAssetName(relativePath))));
  });
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  return target;
};
