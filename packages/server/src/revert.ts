import { relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { activeRollOf, contentBeforeSteps, diffRows, editStepsByPath, escapesFolder, isInFlight, now, partsOfRoll, sensitivePathsOf, type DiffRow, type EditStep, type GraphNode, type Id, type Part, type RevertRecord } from "@branchboard/core";
import { RefusedError, SensitiveFilesError, type BoardService } from "./boards";
import { readFileAtTree } from "./git";
import type { RunService } from "./run/pipeline";
import { hashOfBytes, readWorkspaceState, writeWorkspaceFile, type FileState } from "./workspaceWrites";

export type RevertDirection = "revert" | "redo";

interface PlannedFile {
  path: string;
  target: string | null;
  expectedHash: string | null;
  current: FileState;
  origin: "snapshot" | "inverse" | "redo";
  unavailable?: string;
}

export interface CheckedFile extends PlannedFile {
  conflict: boolean;
}

export interface RevertPreviewFile {
  path: string;
  origin: PlannedFile["origin"];
  conflict: boolean;
  unavailable?: string;
  rows: DiffRow[];
}

const PREVIEW_CONTEXT_LINES = 2;

export const workspaceRelativePath = (workspacePath: string, toolPath: string): string | undefined => {
  const roots = [workspacePath, (() => { try { return realpathSync(workspacePath); } catch { return workspacePath; } })()];
  for (const root of roots) {
    const inside = relative(root, resolve(root, toolPath));
    if (inside !== "" && !escapesFolder(inside)) return inside.replace(/\\/g, "/");
  }
  return undefined;
};

export const fileHashesAfterRun = (workspacePath: string, parts: Part[]): Record<string, string | null> =>
  Object.fromEntries(
    [...editStepsByPath(parts).keys()].flatMap((toolPath): [string, string | null][] => {
      const path = workspaceRelativePath(workspacePath, toolPath);
      if (!path) return [];
      try {
        return [[path, readWorkspaceState(workspacePath, path).hash]];
      } catch {
        return [];
      }
    }),
  );

const withLineEndingsOf = (text: string, reference: string | null): string =>
  reference !== null && reference.includes("\r\n") && !text.includes("\r") ? text.replace(/\n/g, "\r\n") : text;

const planOne = async (workspacePath: string, node: GraphNode, path: string, steps: EditStep[]): Promise<PlannedFile> => {
  const base = { path, target: null, expectedHash: null, current: { text: null, hash: null } as FileState };
  if (node.fileHashes?.[path] === undefined) return { ...base, origin: "inverse", unavailable: "There is no record of this file when the run ended" };
  let current: FileState;
  try {
    current = readWorkspaceState(workspacePath, path);
  } catch (error) {
    return { ...base, origin: "inverse", unavailable: error instanceof Error ? error.message : String(error) };
  }
  const known = { ...base, current, expectedHash: node.fileHashes[path] };
  const fromTree = node.workspaceSnapshot ? await readFileAtTree(workspacePath, node.workspaceSnapshot, path) : { kind: "unavailable" as const };
  if (fromTree.kind === "text") return { ...known, target: withLineEndingsOf(fromTree.text, current.text), origin: "snapshot" };
  if (fromTree.kind === "absent") return { ...known, target: null, origin: "snapshot" };
  const inverse = contentBeforeSteps(steps, current.text);
  return inverse === undefined ? { ...known, origin: "inverse", unavailable: "No earlier version of this file is available" } : { ...known, target: inverse, origin: "inverse" };
};

const planRevert = async (workspacePath: string, node: GraphNode, parts: Part[]): Promise<PlannedFile[]> => {
  const already = new Set(node.reverted?.files.map((file) => file.path));
  const steps = editStepsByPath(partsOfRoll(parts, activeRollOf(node)));
  const planned = [...steps.entries()].flatMap(([toolPath, fileSteps]) => {
    const path = workspaceRelativePath(workspacePath, toolPath);
    return path && !already.has(path) ? [{ path, fileSteps }] : [];
  });
  return Promise.all(planned.map(({ path, fileSteps }) => planOne(workspacePath, node, path, fileSteps)));
};

const planRedo = (workspacePath: string, node: GraphNode): PlannedFile[] =>
  (node.reverted?.files ?? []).map((file) => {
    try {
      return { path: file.path, target: file.afterRun, expectedHash: file.restoredHash, current: readWorkspaceState(workspacePath, file.path), origin: "redo" as const };
    } catch (error) {
      return { path: file.path, target: null, expectedHash: null, current: { text: null, hash: null }, origin: "redo" as const, unavailable: error instanceof Error ? error.message : String(error) };
    }
  });

const checkPlan = (planned: PlannedFile[]): CheckedFile[] => planned.map((file) => ({ ...file, conflict: !file.unavailable && file.current.hash !== file.expectedHash }));

const previewOf = (file: CheckedFile): RevertPreviewFile => ({
  path: file.path,
  origin: file.origin,
  conflict: file.conflict,
  unavailable: file.unavailable,
  rows: file.unavailable ? [] : diffRows(file.current.text ?? "", file.target ?? "", PREVIEW_CONTEXT_LINES),
});

const recordAfterApply = (node: GraphNode, direction: RevertDirection, applied: CheckedFile[]): RevertRecord | null => {
  const previous = node.reverted?.files ?? [];
  if (direction === "redo") {
    const remaining = previous.filter((file) => !applied.some((entry) => entry.path === file.path));
    return remaining.length > 0 ? { at: now(), files: remaining } : null;
  }
  return {
    at: now(),
    files: [...previous, ...applied.map((file) => ({ path: file.path, afterRun: file.current.text, restoredHash: file.target === null ? null : hashOfBytes(file.target) }))],
  };
};

export interface RevertCommand {
  boardId: Id;
  nodeId: Id;
  redo?: boolean;
  dryRun?: boolean;
  paths?: string[];
  force?: boolean;
  allowSensitive?: boolean;
}

export const revertEdits = async ({ boards, runs }: { boards: BoardService; runs: RunService }, command: RevertCommand) => {
  const state = boards.stateOf(command.boardId);
  const node = state.graph.nodes[command.nodeId];
  if (!node || node.deleted || node.kind !== "turn") throw new RefusedError("That node has no file edits to revert");
  const workspacePath = state.board.workspacePath;
  const direction: RevertDirection = command.redo === true ? "redo" : "revert";
  const busy = isInFlight(node) || runs.listRuns().some((run) => boards.stateOf(run.boardId).board.workspacePath === workspacePath);
  if (busy && command.dryRun !== true) throw new RefusedError("Wait for the running jobs in this project folder to finish before reverting");
  const checked = checkPlan(direction === "redo" ? planRedo(workspacePath, node) : await planRevert(workspacePath, node, state.parts[node.id] ?? []));
  if (command.dryRun === true) return { direction, files: checked.map(previewOf) };
  const chosen = checked.filter((file) => !file.unavailable && (command.paths === undefined || command.paths.includes(file.path)) && (!file.conflict || command.force === true));
  if (chosen.length === 0) throw new RefusedError("There is nothing to revert with the chosen files");
  const sensitive = sensitivePathsOf(chosen.map((file) => file.path));
  if (sensitive.length > 0 && command.allowSensitive !== true) throw new SensitiveFilesError(sensitive);
  const applied: CheckedFile[] = [];
  try {
    for (const file of chosen) {
      writeWorkspaceFile(workspacePath, file.path, file.target, { expectedHash: file.current.hash, allowSensitive: true });
      applied.push(file);
    }
  } finally {
    if (applied.length > 0) boards.commitRunPatch(command.boardId, { type: "patch", patch: { nodes: { [node.id]: { id: node.id, reverted: recordAfterApply(node, direction, applied) } }, edges: {} } });
  }
  return { direction, applied: applied.map((file) => file.path), skipped: checked.length - applied.length };
};
