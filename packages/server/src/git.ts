import { execFile } from "node:child_process";
import { relative } from "node:path";
import type { GitBranches, GitChanges } from "@branchboard/core";

const GIT_TIMEOUT_MS = 8000;
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const BRANCH_NAME_PATTERN = /^[\w./@+-]+$/;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const runGit = (workspacePath: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd: workspacePath, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
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

export const changedLinesOf = (diff: string): GitChanges => {
  const added: number[] = [];
  const removedAfter: number[] = [];
  let removed = 0;
  for (const line of diff.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (!header) continue;
    const removedCount = Number(header[1] ?? 1);
    const start = Number(header[2]);
    const count = Number(header[3] ?? 1);
    removed += removedCount;
    if (removedCount > 0) removedAfter.push(count === 0 ? start : start - 1);
    for (let offset = 0; offset < count; offset += 1) added.push(start + offset);
  }
  return { added, removed, removedAfter };
};

export const readChanges = async (workspacePath: string, absolutePath: string, current: string | undefined, ref: string | undefined): Promise<GitChanges> => {
  const file = workspaceRelative(workspacePath, absolutePath);
  const range = ref && current ? [`${current}...${ref}`] : ["HEAD"];
  try {
    return changedLinesOf(await runGit(workspacePath, ["diff", "-U0", "--no-color", "--no-ext-diff", ...range, "--", file]));
  } catch {
    return { added: [], removed: 0, removedAfter: [] };
  }
};
