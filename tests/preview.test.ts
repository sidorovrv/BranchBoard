import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeViewOfPath } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { capabilityOfPath, createCapabilityStore, loggedPathOf } from "../packages/server/src/capabilities";

const PORT = 47321;
const ACCESS = "c".repeat(64);
const HOST = `127.0.0.1:${PORT}`;
const trusted = { host: HOST, origin: `http://${HOST}`, "content-type": "application/json", cookie: `branchboard_access_${PORT}=${ACCESS}` };
const directory = mkdtempSync(join(tmpdir(), "branchboard-preview-"));
const workspaceA = join(directory, "a");
const workspaceB = join(directory, "b");
let server: ReturnType<typeof createApp>;
let boardA = "";
let boardB = "";

const send = async (path: string, body?: unknown, headers: Record<string, string> = trusted) => {
  const response = await server.app.request(`http://${HOST}${path}`, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, headers: response.headers, text: await response.text() };
};

const command = async (body: Record<string, unknown>) => ({ ...(await send("/api/commands", body)) });

const previewUrlOf = async (boardId: string, path: string): Promise<string> => {
  const node = JSON.parse((await command({ type: "extractFile", boardId, path })).text).nodeId;
  return JSON.parse((await command({ type: "openPreview", boardId, nodeId: node })).text).url;
};

const anonymous = { host: HOST };

beforeAll(async () => {
  [workspaceA, workspaceB].forEach((folder) => mkdirSync(join(folder, "site"), { recursive: true }));
  writeFileSync(join(workspaceA, "site", "index.html"), '<link rel="stylesheet" href="style.css"><script src="app.js"></script>hello');
  writeFileSync(join(workspaceA, "site", "style.css"), "body{color:red}");
  writeFileSync(join(workspaceA, "site", "app.js"), "window.x=1");
  writeFileSync(join(workspaceA, ".env"), "SECRET=1");
  writeFileSync(join(workspaceA, "readme.md"), "# hi");
  writeFileSync(join(workspaceB, "site", "other.html"), "other board");
  writeFileSync(join(directory, "outside.txt"), "outside");
  server = createApp({ databasePath: join(directory, "t.db"), security: { port: PORT, extraOrigins: [], accessToken: ACCESS } });
  boardA = JSON.parse((await command({ type: "createBoard", title: "A", workspacePath: workspaceA, mode: "fake" })).text).id;
  boardB = JSON.parse((await command({ type: "createBoard", title: "B", workspacePath: workspaceB, mode: "fake" })).text).id;
});

afterAll(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("HTML preview", () => {
  it("picks the html view for html files", () => {
    expect(codeViewOfPath("site/index.html")).toBe("html");
    expect(codeViewOfPath("notes.md")).toBe("markdown");
    expect(codeViewOfPath("app.ts")).toBe("source");
  });

  it("serves the page and its relative assets read-only without the cookie, frameable only by the app", async () => {
    const url = await previewUrlOf(boardA, "site/index.html");
    expect(url).toMatch(/^\/preview\/[0-9a-f]{48}\/site\/index\.html$/);
    const page = await send(url, undefined, anonymous);
    expect(page.status).toBe(200);
    expect(page.text).toContain("hello");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'$/);
    expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const stylesheet = await send(url.replace("index.html", "style.css"), undefined, anonymous);
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
    expect((await send(url.replace("index.html", "app.js"), undefined, anonymous)).headers.get("content-type")).toContain("text/javascript");
    expect((await send("/api/boards", undefined, anonymous)).status).toBe(401);
    expect((await server.app.request(`http://${HOST}${url}`, { method: "POST", headers: anonymous, body: "x" })).status).toBe(405);
  });

  it("refuses a wrong secret, other folders, traversal, secrets files and other types", async () => {
    const url = await previewUrlOf(boardA, "site/index.html");
    const secret = url.split("/")[2];
    expect((await send(`/preview/${"0".repeat(48)}/site/index.html`, undefined, anonymous)).status).toBe(404);
    expect((await send(`/preview/${secret}/site/other.html`, undefined, anonymous)).status).toBe(404);
    expect((await send(`/preview/${secret}/..%2f..%2foutside.txt`, undefined, anonymous)).status).toBe(404);
    expect((await send(`/preview/${secret}/site/..%2f..%2foutside.txt`, undefined, anonymous)).status).toBe(404);
    expect((await send(`/preview/${secret}/.env`, undefined, anonymous)).status).toBe(404);
    expect((await send(`/preview/${secret}/readme.md`, undefined, anonymous)).status).toBe(404);
    expect((await send(`/preview/${secret}/site/%E0%A4%A`, undefined, anonymous)).status).toBe(404);
  });

  it("does not follow a link that leaves the folder", async () => {
    const url = await previewUrlOf(boardA, "site/index.html");
    const secret = url.split("/")[2];
    try {
      symlinkSync(directory, join(workspaceA, "site", "escape"), "junction");
    } catch {
      return;
    }
    expect((await send(`/preview/${secret}/site/escape/outside.txt`, undefined, anonymous)).status).toBe(404);
  });

  it("is bound to one folder: a secret for board A cannot read board B", async () => {
    const urlB = await previewUrlOf(boardB, "site/other.html");
    const secretB = urlB.split("/")[2];
    expect((await send(urlB, undefined, anonymous)).text).toBe("other board");
    expect((await send(`/preview/${secretB}/site/index.html`, undefined, anonymous)).status).toBe(404);
  });

  it("refuses to preview a file that is not html", async () => {
    const markdown = JSON.parse((await command({ type: "extractFile", boardId: boardA, path: "readme.md" })).text).nodeId;
    expect((await command({ type: "openPreview", boardId: boardA, nodeId: markdown })).status).toBe(409);
  });

  it("does not treat object prototype names as capability kinds", async () => {
    expect(capabilityOfPath("/constructor/abcdef")).toBeUndefined();
    expect(capabilityOfPath("/__proto__/abcdef")).toBeUndefined();
    expect((await send("/constructor/abcdef", undefined, anonymous)).status).toBe(401);
  });

  it("masks capability secrets in logged paths", () => {
    expect(loggedPathOf("/preview/0123456789abcdef/site/index.html")).toBe("/preview/…/site/index.html");
    expect(loggedPathOf("/mcp/0123456789abcdef")).toBe("/mcp/…/");
    expect(loggedPathOf("/api/boards")).toBe("/api/boards");
  });
});

describe("capability store", () => {
  it("expires after the ttl, slides on use, reuses the secret per subject and keeps kinds apart", () => {
    let now = 1000;
    const store = createCapabilityStore(() => now);
    const secret = store.issue("preview", "board", 100);
    expect(store.issue("preview", "board", 100)).toBe(secret);
    expect(store.resolve("mcp", secret)).toBeUndefined();
    now += 60;
    expect(store.resolve("preview", secret)).toBe("board");
    now += 60;
    expect(store.resolve("preview", secret)).toBe("board");
    now += 101;
    expect(store.resolve("preview", secret)).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});
