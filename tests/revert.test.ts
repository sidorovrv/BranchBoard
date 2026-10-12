import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentBeforeSteps, editStepsByPath, type GraphNode, type Part } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { readFileAtTree, snapshotWorkspace } from "../packages/server/src/git";
import { fakeRuntime } from "../packages/server/src/runtimes/fake";
import { streamEventMap, type LooseNative } from "../packages/server/src/runtimes/commonEvents";
import type { RuntimeSteps } from "../packages/server/src/run/types";
import { resolveInsideWorkspace, writeWorkspaceFile } from "../packages/server/src/workspaceWrites";

const PORT = 47331;
const HOST = `127.0.0.1:${PORT}`;
const trusted = { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" };
const directory = mkdtempSync(join(tmpdir(), "branchboard-revert-"));

const ACTION = /^(write|edit) (\S+) :: (.*)$/m;

const editingRuntime: RuntimeSteps<LooseNative, object> = {
  ...fakeRuntime,
  editsFiles: true,
  canSuggestTitles: false,
  eventMap: { ...streamEventMap, done: () => [{ type: "done" }] },
  openSession: async () => ({}),
  async *execute(_handle, input, scope) {
    const match = ACTION.exec(input);
    if (match) {
      const [, action, path, rest] = match;
      const target = join(scope.workspacePath, path);
      if (action === "write") {
        const existed = existsSync(target);
        writeFileSync(target, rest.replace(/\\n/g, "\n"));
        yield { type: "tool-start", partId: "t1", tool: "Write", description: `Write ${path}`, input: { file_path: path, content: rest.replace(/\\n/g, "\n") } };
        yield { type: "tool-done", partId: "t1", output: existed ? `The file ${path} has been updated successfully.` : `File created successfully at: ${path}`, isError: false };
      } else {
        const [oldText, newText] = rest.split(" => ");
        writeFileSync(target, readFileSync(target, "utf8").replace(oldText, newText));
        yield { type: "tool-start", partId: "t1", tool: "Edit", description: `Edit ${path}`, input: { file_path: path, old_string: oldText, new_string: newText } };
        yield { type: "tool-done", partId: "t1", output: "ok", isError: false };
      }
    }
    yield { type: "done" };
  },
};

const git = (folder: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: folder, stdio: "pipe" }).toString();

let server: ReturnType<typeof createApp>;
let seed = 0;

const send = async (path: string, body?: unknown) => {
  const response = await server.app.request(`http://${HOST}${path}`, { method: body ? "POST" : "GET", headers: trusted, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, json: text.startsWith("{") ? JSON.parse(text) : undefined };
};

const command = (body: Record<string, unknown>) => send("/api/commands", body);

const newWorkspace = (files: Record<string, string>, isRepo = false): string => {
  const folder = join(directory, `w${seed++}`);
  mkdirSync(folder, { recursive: true });
  Object.entries(files).forEach(([name, content]) => writeFileSync(join(folder, name), content));
  if (isRepo) {
    git(folder, "init", "-q", "-b", "main");
    git(folder, "add", ".");
    git(folder, "commit", "-q", "-m", "first");
  }
  return folder;
};

const boardIn = async (workspacePath: string): Promise<string> => (await command({ type: "createBoard", title: "Revert", workspacePath, mode: "fake" })).json.id;

const nodeOf = async (boardId: string, nodeId: string): Promise<GraphNode> => (await send(`/api/boards/${boardId}/graph`)).json.graph.nodes[nodeId];

const runPrompt = async (boardId: string, prompt: string, parentIds: string[] = []): Promise<string> => {
  const nodeId = (await command({ type: "reply", boardId, prompt, parentIds })).json.nodeId;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if ((await nodeOf(boardId, nodeId)).status === "done") return nodeId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The run did not finish");
};

const read = (folder: string, name: string) => readFileSync(join(folder, name), "utf8");

beforeAll(() => {
  server = createApp({ databasePath: join(directory, "t.db"), security: { port: PORT, extraOrigins: [] }, runtimes: { fake: editingRuntime, opencode: editingRuntime, claude: editingRuntime } });
});

afterAll(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("inverting recorded edits", () => {
  const part = (tool: string, input: Record<string, unknown>, output = "ok"): Part => ({ id: tool + JSON.stringify(input), nodeId: "n", seq: 0, type: "tool", text: "", meta: { tool, input, output, status: "done" } });

  it("undoes edits in reverse order and a created file means delete", () => {
    const steps = editStepsByPath([
      part("Write", { file_path: "a.txt", content: "one two" }, "File created successfully at: a.txt"),
      part("Edit", { file_path: "a.txt", old_string: "two", new_string: "2" }),
      part("MultiEdit", { file_path: "a.txt", edits: [{ old_string: "one", new_string: "1" }] }),
    ]).get("a.txt")!;
    expect(contentBeforeSteps(steps, "1 2")).toBeNull();
    expect(contentBeforeSteps(steps.slice(1), "1 2")).toBe("one two");
  });

  it("gives up when the result cannot be inverted safely", () => {
    const overwrite = editStepsByPath([part("Write", { file_path: "a.txt", content: "x" }, "updated")]).get("a.txt")!;
    expect(contentBeforeSteps(overwrite, "x")).toBeUndefined();
    const ambiguous = editStepsByPath([part("Edit", { file_path: "a.txt", old_string: "a", new_string: "b" })]).get("a.txt")!;
    expect(contentBeforeSteps(ambiguous, "b b")).toBeUndefined();
    expect(contentBeforeSteps(ambiguous, "unrelated")).toBeUndefined();
  });
});

describe("guarded workspace writes", () => {
  const folder = newWorkspace({ "keep.txt": "keep" });

  it("writes, deletes and creates folders inside the workspace", () => {
    writeWorkspaceFile(folder, "deep/er/new.txt", "x");
    expect(read(folder, "deep/er/new.txt")).toBe("x");
    writeWorkspaceFile(folder, "deep/er/new.txt", null);
    expect(existsSync(join(folder, "deep/er/new.txt"))).toBe(false);
  });

  it("refuses paths outside, sensitive paths and a changed file", () => {
    expect(() => resolveInsideWorkspace(folder, "../escape.txt")).toThrow();
    expect(() => writeWorkspaceFile(folder, "deep/../../escape.txt", "x")).toThrow();
    expect(() => writeWorkspaceFile(folder, ".env", "S=1")).toThrow(/sensitive/);
    writeWorkspaceFile(folder, ".env", "S=1", { allowSensitive: true });
    expect(() => writeWorkspaceFile(folder, "keep.txt", "new", { expectedHash: "0".repeat(64) })).toThrow(/changed/);
    expect(read(folder, "keep.txt")).toBe("keep");
  });
});

describe("git workspace snapshot", () => {
  it("records the working tree without touching the index or refs", async () => {
    const folder = newWorkspace({ "a.txt": "one\n" }, true);
    writeFileSync(join(folder, "a.txt"), "changed\n");
    writeFileSync(join(folder, "untracked.txt"), "new\n");
    const statusBefore = git(folder, "status", "--porcelain");
    const headBefore = git(folder, "rev-parse", "HEAD");
    const tree = await snapshotWorkspace(folder);
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
    expect(git(folder, "status", "--porcelain")).toBe(statusBefore);
    expect(git(folder, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await readFileAtTree(folder, tree!, "a.txt")).toEqual({ kind: "text", text: "changed\n" });
    expect(await readFileAtTree(folder, tree!, "untracked.txt")).toEqual({ kind: "text", text: "new\n" });
    expect(await readFileAtTree(folder, tree!, "missing.txt")).toEqual({ kind: "absent" });
    expect(await readFileAtTree(folder, "f".repeat(40), "a.txt")).toEqual({ kind: "unavailable" });
  });

  it("returns nothing outside a repository", async () => {
    expect(await snapshotWorkspace(newWorkspace({ "a.txt": "x" }))).toBeUndefined();
  });
});

describe("F-1 revert in a plain folder", () => {
  it("restores an edited file, deletes a created one and can redo", async () => {
    const folder = newWorkspace({ "a.txt": "one\ntwo\n" });
    const boardId = await boardIn(folder);
    const nodeId = await runPrompt(boardId, "edit a.txt :: two => TWO");
    const created = await runPrompt(boardId, "write fresh.txt :: hello");
    expect(read(folder, "a.txt")).toBe("one\nTWO\n");
    const preview = (await command({ type: "revertEdits", boardId, nodeId, dryRun: true })).json;
    expect(preview.files).toMatchObject([{ path: "a.txt", conflict: false, origin: "inverse" }]);
    expect(preview.files[0].rows.map((row: { kind: string }) => row.kind)).toContain("remove");
    expect((await command({ type: "revertEdits", boardId, nodeId })).json.applied).toEqual(["a.txt"]);
    expect(read(folder, "a.txt")).toBe("one\ntwo\n");
    expect((await nodeOf(boardId, nodeId)).reverted?.files).toHaveLength(1);
    expect((await command({ type: "revertEdits", boardId, nodeId: created })).json.applied).toEqual(["fresh.txt"]);
    expect(existsSync(join(folder, "fresh.txt"))).toBe(false);
    expect((await command({ type: "revertEdits", boardId, nodeId, redo: true })).json.applied).toEqual(["a.txt"]);
    expect(read(folder, "a.txt")).toBe("one\nTWO\n");
    expect((await nodeOf(boardId, nodeId)).reverted).toBeNull();
  });

  it("skips a file that was edited after the run unless forced", async () => {
    const folder = newWorkspace({ "a.txt": "one\ntwo\n", "b.txt": "b\n" });
    const boardId = await boardIn(folder);
    const nodeId = await runPrompt(boardId, "edit a.txt :: two => TWO");
    writeFileSync(join(folder, "a.txt"), "one\nTWO\nmine\n");
    const preview = (await command({ type: "revertEdits", boardId, nodeId, dryRun: true })).json;
    expect(preview.files[0].conflict).toBe(true);
    expect((await command({ type: "revertEdits", boardId, nodeId })).status).toBe(409);
    expect(read(folder, "a.txt")).toBe("one\nTWO\nmine\n");
    const forced = await command({ type: "revertEdits", boardId, nodeId, force: true });
    expect(forced.json.applied).toEqual(["a.txt"]);
    expect(read(folder, "a.txt")).toBe("one\ntwo\nmine\n");
  });

  it("cannot restore a file that was overwritten without any earlier copy", async () => {
    const folder = newWorkspace({ "a.txt": "original\n" });
    const boardId = await boardIn(folder);
    const nodeId = await runPrompt(boardId, "write a.txt :: replaced");
    const preview = (await command({ type: "revertEdits", boardId, nodeId, dryRun: true })).json;
    expect(preview.files[0].unavailable).toMatch(/earlier version/);
    expect((await command({ type: "revertEdits", boardId, nodeId })).status).toBe(409);
    expect(read(folder, "a.txt")).toBe("replaced");
  });

  it("asks before touching a sensitive file", async () => {
    const folder = newWorkspace({});
    const boardId = await boardIn(folder);
    const nodeId = await runPrompt(boardId, "write .env :: SECRET=1");
    const refused = await command({ type: "revertEdits", boardId, nodeId });
    expect(refused.status).toBe(409);
    expect(refused.json.sensitiveFiles).toEqual([".env"]);
    expect((await command({ type: "revertEdits", boardId, nodeId, allowSensitive: true })).json.applied).toEqual([".env"]);
    expect(existsSync(join(folder, ".env"))).toBe(false);
  });

  it("has nothing to revert for an imported or pasted node that carries no record", async () => {
    const folder = newWorkspace({ "a.txt": "x\n" });
    const boardId = await boardIn(folder);
    const nodeId = await runPrompt(boardId, "edit a.txt :: x => y");
    const exported = await send(`/api/boards/${boardId}/export`);
    const projectId = (await send(`/api/boards/${boardId}/graph`)).json.board.projectId;
    const imported = (await command({ type: "importBoard", projectId, raw: JSON.stringify(exported.json) })).json;
    const importedNode = Object.values((await send(`/api/boards/${imported.id}/graph`)).json.graph.nodes as Record<string, GraphNode>).find((node) => node.prompt.startsWith("edit"))!;
    const preview = (await command({ type: "revertEdits", boardId: imported.id, nodeId: importedNode.id, dryRun: true })).json;
    expect(preview.files.every((file: { unavailable?: string }) => file.unavailable)).toBe(true);
    expect(nodeId).toBeDefined();
  });
});

describe("F-1 revert in a git repository", () => {
  it("restores an overwritten file from the snapshot and leaves the index alone", async () => {
    const folder = newWorkspace({ "a.txt": "original\n" }, true);
    const boardId = await boardIn(folder);
    const nodeId = await runPrompt(boardId, "write a.txt :: replaced");
    const node = await nodeOf(boardId, nodeId);
    expect(node.workspaceSnapshot).toMatch(/^[0-9a-f]{40,64}$/);
    expect(git(folder, "diff", "--cached", "--name-only")).toBe("");
    const preview = (await command({ type: "revertEdits", boardId, nodeId, dryRun: true })).json;
    expect(preview.files[0]).toMatchObject({ path: "a.txt", origin: "snapshot", conflict: false });
    await command({ type: "revertEdits", boardId, nodeId });
    expect(read(folder, "a.txt")).toBe("original\n");
    expect(git(folder, "status", "--porcelain")).toBe("");
  });

  it("falls back to the recorded edits when the snapshot has been pruned", async () => {
    const folder = newWorkspace({ "a.txt": "one\ntwo\n" }, true);
    const boardId = await boardIn(folder);
    const nodeId = await runPrompt(boardId, "edit a.txt :: two => TWO");
    server.boards.commitRunPatch(boardId, { type: "patch", patch: { nodes: { [nodeId]: { id: nodeId, workspaceSnapshot: "a".repeat(40) } }, edges: {} } });
    const preview = (await command({ type: "revertEdits", boardId, nodeId, dryRun: true })).json;
    expect(preview.files[0].origin).toBe("inverse");
    await command({ type: "revertEdits", boardId, nodeId });
    expect(read(folder, "a.txt")).toBe("one\ntwo\n");
  });

  it("deletes a file the run created", async () => {
    const folder = newWorkspace({ "a.txt": "x\n" }, true);
    const boardId = await boardIn(folder);
    const nodeId = await runPrompt(boardId, "write new.txt :: hi");
    await command({ type: "revertEdits", boardId, nodeId });
    expect(existsSync(join(folder, "new.txt"))).toBe(false);
  });
});
