import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleOptions, buildWebBundle } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(here, "..");
const repositoryRoot = resolve(packageDirectory, "..", "..");
const stagingDirectory = join(packageDirectory, "dist", "sea");
const outputDirectory = join(packageDirectory, "dist", "binary");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
};

const filesUnder = (directory) =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

const webAssets = (webBundle) => {
  const files = filesUnder(webBundle).map((path) => relative(webBundle, path).split(sep).join("/")).sort();
  const hash = createHash("sha256");
  files.forEach((file) => hash.update(file).update(readFileSync(join(webBundle, file))));
  const assets = { "web-manifest.json": join(stagingDirectory, "web-manifest.json") };
  writeFileSync(assets["web-manifest.json"], JSON.stringify({ id: hash.digest("hex").slice(0, 16), files }));
  files.forEach((file) => (assets[`web/${file}`] = join(webBundle, file)));
  return assets;
};

const binaryName = () => `branchboard-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;

const main = async () => {
  const webBundle = await buildWebBundle();
  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  const mainScript = join(stagingDirectory, "main.cjs");
  await build(bundleOptions({ entryPoints: [join(packageDirectory, "src", "binary.ts")], format: "cjs", outfile: mainScript }));
  const blob = join(stagingDirectory, "sea-prep.blob");
  const configPath = join(stagingDirectory, "sea-config.json");
  writeFileSync(configPath, JSON.stringify({ main: mainScript, output: blob, disableExperimentalSEAWarning: true, assets: webAssets(webBundle) }));
  run(process.execPath, ["--experimental-sea-config", configPath]);
  const executable = join(outputDirectory, binaryName());
  copyFileSync(process.execPath, executable);
  if (process.platform === "darwin") run("codesign", ["--remove-signature", executable]);
  const postject = join(repositoryRoot, "node_modules", "postject", "dist", "cli.js");
  const injectArguments = [postject, executable, "NODE_SEA_BLOB", blob, "--sentinel-fuse", FUSE];
  run(process.execPath, process.platform === "darwin" ? [...injectArguments, "--macho-segment-name", "NODE_SEA"] : injectArguments);
  if (process.platform === "darwin") run("codesign", ["--sign", "-", executable]);
  console.log(`Built ${executable}`);
};

await main();
