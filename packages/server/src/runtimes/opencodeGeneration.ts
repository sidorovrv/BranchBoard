import { log } from "../log";
import { locateOpencode, locateOpencode2, type Location } from "./opencodeLocator";
import { spawnExecutable } from "./spawnProcess";

export type OpencodeGeneration = 1 | 2;

const VERSION_TIMEOUT_MS = 10000;
const VERSION_PATTERN = /(\d+)\.\d+\.\d+/;

const majorVersions = new Map<string, number>();
let detection: Promise<OpencodeGeneration> | undefined;

export const majorVersionOf = (versionOutput: string): number | undefined => {
  const major = VERSION_PATTERN.exec(versionOutput)?.[1];
  return major === undefined ? undefined : Number(major);
};

const readVersionOutput = (executable: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawnExecutable(executable, ["--version"], { cwd: process.cwd(), env: process.env });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no version within ${VERSION_TIMEOUT_MS}ms`));
    }, VERSION_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });

const generationOfExecutable = async (executable: string): Promise<OpencodeGeneration> => {
  const major = majorVersionOf(await readVersionOutput(executable));
  if (major === undefined) throw new Error("the version output has no number");
  majorVersions.set(executable, major);
  return major >= 2 ? 2 : 1;
};

const detectGeneration = async (): Promise<OpencodeGeneration> => {
  const { path } = locateOpencode();
  if (!path) return locateOpencode2().path ? 2 : 1;
  const generation = await generationOfExecutable(path).catch((error) => {
    log.warn("opencode", `Could not read the version of ${path}, assuming OpenCode 1`, error);
    return 1 as const;
  });
  log.info("opencode", `${path} is OpenCode ${generation}`);
  return generation;
};

export const opencodeGeneration = (): Promise<OpencodeGeneration> => (detection ??= detectGeneration());

export const forgetOpencodeGeneration = () => {
  detection = undefined;
  majorVersions.clear();
};

export const locateOpencodeGeneration2 = (): Location => {
  const own = locateOpencode2();
  if (own.path) return own;
  const shared = locateOpencode();
  return shared.path && (majorVersions.get(shared.path) ?? 0) >= 2 ? shared : own;
};
