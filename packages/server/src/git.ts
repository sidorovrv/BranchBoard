import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { diffRows, gitChangesOf, type GitBranches, type GitChanges } from "@branchboard/core";

const GIT_TIMEOUT_MS = 8000;
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const BRANCH_NAME_PATTERN = /^[\w./@+-]+$/;
const TREE_ID_PATTERN = /^[0-9a-f]{40,64}$/;

const SNAPSHOT_TIMEOUT_MS = 60 * 1000;
const MISSING_PATH_PATTERN = /does not exist|exists on disk, but not in/i;

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

class GitFailure extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

const runGit = (workspacePath: string, args: string[], { env, timeoutMs = GIT_TIMEOUT_MS }: GitOptions = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd: workspacePath, timeout: timeoutMs, maxBuffer: GIT_MAX_OUTPUT_BYTES, windowsHide: true, env: env ? { ...process.env, ...env } : undefined }, (error, stdout, stderr) =>
      error ? reject(new GitFailure(error.message, String(stderr))) : resolve(stdout),
    );
  });

const linesOf = (output: string): string[] => output.split("\n").map((line) => line.trim()).filter(Boolean);

export const readBranches = async (workspacePath: string): Promise<GitBranches> => {
  try {
    const inside = (await runGit(workspacePath, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return { isRepo: false, branches: [] };
    const current = (await runGit(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const branches = linesOf(await runGit(workspacePath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]));
    return { isRepo: true, current: current === "HEAD" ? undefined : current, branches };
  } catch {
    return { isRepo: false, branches: [] };
  }
};

export const isKnownBranch = async (workspacePath: string, ref: string): Promise<boolean> =>
  BRANCH_NAME_PATTERN.test(ref) && (await readBranches(workspacePath)).branches.includes(ref);

const workspaceRelative = (workspacePath: string, absolutePath: string): string => relative(workspacePath, absolutePath).replace(/\\/g, "/");

export const readFileAtBranch = (workspacePath: string, absolutePath: string, ref: string): Promise<string> =>
  runGit(workspacePath, ["show", `${ref}:./${workspaceRelative(workspacePath, absolutePath)}`]);

export const snapshotWorkspace = async (workspacePath: string): Promise<string | undefined> => {
  let scratch: string | undefined;
  try {
    if ((await runGit(workspacePath, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") return undefined;
    const realIndex = resolve(workspacePath, (await runGit(workspacePath, ["rev-parse", "--git-path", "index"])).trim());
    scratch = mkdtempSync(join(tmpdir(), "branchboard-index-"));
    const temporaryIndex = join(scratch, "index");
    if (existsSync(realIndex)) copyFileSync(realIndex, temporaryIndex);
    const env = { GIT_INDEX_FILE: temporaryIndex };
    await runGit(workspacePath, ["add", "-A"], { env, timeoutMs: SNAPSHOT_TIMEOUT_MS });
    return (await runGit(workspacePath, ["write-tree"], { env })).trim() || undefined;
  } catch {
    return undefined;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
};

const isIgnored = (workspacePath: string, path: string): Promise<boolean> =>
  runGit(workspacePath, ["check-ignore", "-q", "--", path]).then(
    () => true,
    () => false,
  );

export type TreeFile = { kind: "text"; text: string } | { kind: "absent" } | { kind: "unavailable" };

export const readFileAtTree = async (workspacePath: string, tree: string, relativePath: string): Promise<TreeFile> => {
  if (!TREE_ID_PATTERN.test(tree)) return { kind: "unavailable" };
  try {
    await runGit(workspacePath, ["cat-file", "-e", tree]);
  } catch {
    return { kind: "unavailable" };
  }
  const path = relativePath.replace(/\\/g, "/");
  try {
    const text = await runGit(workspacePath, ["show", `${tree}:./${path}`]);
    return text.includes("\0") ? { kind: "unavailable" } : { kind: "text", text };
  } catch (error) {
    if (!(error instanceof GitFailure) || !MISSING_PATH_PATTERN.test(error.stderr)) return { kind: "unavailable" };
    return (await isIgnored(workspacePath, path)) ? { kind: "unavailable" } : { kind: "absent" };
  }
};

export const NO_CHANGES: GitChanges = { added: [], removed: 0, removedBlocks: [] };

const readForkPointFile = async (workspacePath: string, absolutePath: string, current: string, ref: string): Promise<string> => {
  const forkPoint = (await runGit(workspacePath, ["merge-base", current, ref])).trim();
  try {
    return await readFileAtBranch(workspacePath, absolutePath, forkPoint);
  } catch (error) {
    if (error instanceof GitFailure && MISSING_PATH_PATTERN.test(error.stderr)) return "";
    throw error;
  }
};

export const readChanges = async (workspacePath: string, absolutePath: string, current: string | undefined, ref: string | undefined, shownText: string): Promise<GitChanges> => {
  try {
    const base = ref && current ? await readForkPointFile(workspacePath, absolutePath, current, ref) : await readFileAtBranch(workspacePath, absolutePath, "HEAD");
    return gitChangesOf(diffRows(base, shownText, Infinity));
  } catch {
    return NO_CHANGES;
  }
};
