import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { build as buildWeb } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(here, "..");
const repositoryRoot = resolve(packageDirectory, "..", "..");
const webDirectory = join(repositoryRoot, "packages", "web");
const outputDirectory = join(packageDirectory, "dist");
const { version } = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));

export const requireModuleShim = 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);';

export const bundleOptions = (extra = {}) => ({
  bundle: true,
  platform: "node",
  target: "node22",
  legalComments: "external",
  external: ["bufferutil", "utf-8-validate"],
  define: { __BRANCHBOARD_VERSION__: JSON.stringify(version) },
  ...extra,
});

export const buildWebBundle = async () => {
  await buildWeb({ root: webDirectory, logLevel: "warn" });
  return join(webDirectory, "dist");
};

const main = async () => {
  const webBundle = await buildWebBundle();
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  await build(
    bundleOptions({
      entryPoints: [join(packageDirectory, "src", "cli.ts")],
      format: "esm",
      outfile: join(outputDirectory, "branchboard.mjs"),
      banner: { js: requireModuleShim },
    }),
  );
  cpSync(webBundle, join(outputDirectory, "web"), { recursive: true });
  copyFileSync(join(repositoryRoot, "LICENSE"), join(packageDirectory, "LICENSE"));
  const publicReadme = join(repositoryRoot, "release", "README.md");
  if (existsSync(publicReadme)) copyFileSync(publicReadme, join(packageDirectory, "README.md"));
  console.log(`Built branchboard ${version} in ${outputDirectory}`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
