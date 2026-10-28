import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embedFiles, importBoardDocument, MAX_FILE_BYTES, recoveryOfMessage, sanitiseFiles, type BoardDocument, type GraphNode } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { quoteForCmdShell } from "../packages/server/src/runtimes/spawnProcess";
import { locateExecutable } from "../packages/server/src/runtimes/executableLocator";
import { highlightCode } from "../packages/web/src/kit/highlight";
import { sanitizeSchema } from "../packages/web/src/kit/markdownSchema";
import { appClient } from "./support";

const PORT = 47311;
const directory = mkdtempSync(join(tmpdir(), "branchboard-export-recovery-"));
const workspace = join(directory, "workspace");
let server: ReturnType<typeof createApp>;
let boardId = "";
let projectId = "";

const { trusted, send, request, command, view, waitForStatus } = appClient(() => server, PORT);

const upload = async (name: string, content: string | Uint8Array, type: string) => {
  const response = await send(`/api/boards/${boardId}/attachments?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...trusted, "content-type": type }, body: new Blob([content as BlobPart]) });
  return (await response.json()) as { id: string; name: string; mime: string; size: number };
};

beforeAll(async () => {
  mkdirSync(workspace);
  server = createApp({ databasePath: join(directory, "t.db"), security: { port: PORT, extraOrigins: [] } });
  boardId = (await command({ type: "createBoard", title: "Phase 3", workspacePath: workspace, mode: "fake" })).json.id;
  projectId = (await view(boardId)).board.projectId;
});

afterAll(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("export with files", () => {
  it("round-trips an image and a text file with their bytes", async () => {
    const image = await upload("pic.png", PNG, "image/png");
    const text = await upload("notes.txt", "hello world", "text/plain");
    const fileNode = (await command({ type: "file", boardId, attachmentIds: [image.id, text.id] })).json.nodeId;
    await command({ type: "extractAttachment", boardId, attachmentId: text.id, originId: fileNode });
    const exported = await request(`/api/boards/${boardId}/export`);
    const document = JSON.parse(exported.text) as BoardDocument;
    expect(Object.keys(document.files ?? {}).sort()).toEqual([image.id, text.id].sort());
    const imported = (await command({ type: "importBoard", projectId, raw: exported.text })).json;
    const nodes = Object.values((await view(imported.id)).graph.nodes);
    const importedFileNode = nodes.find((node) => node.kind === "file")!;
    expect(importedFileNode.attachments).toHaveLength(2);
    const [first, second] = importedFileNode.attachments!;
    expect([first.id, second.id]).not.toContain(image.id);
    const bytes = await send(`/api/attachments/${first.id}`, { headers: { host: trusted.host } });
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(first.name === "pic.png" ? PNG : new TextEncoder().encode("hello world"));
    const importedCode = nodes.find((node) => node.kind === "code" && node.title === "notes.txt")!;
    expect(importedCode.sourceAttachmentId).toBeDefined();
    expect([image.id, text.id]).not.toContain(importedCode.sourceAttachmentId);
  });

  it("leaves files out when asked and imports such a document without attachments", async () => {
    const exported = await request(`/api/boards/${boardId}/export?files=0`);
    expect(JSON.parse(exported.text).files).toBeUndefined();
    const imported = (await command({ type: "importBoard", projectId, raw: exported.text })).json;
    const nodes = Object.values((await view(imported.id)).graph.nodes);
    expect(nodes.every((node) => node.attachments === undefined)).toBe(true);
    expect(nodes.find((node) => node.kind === "code")?.sourceAttachmentId).toBeUndefined();
  });

  it("imports a version 1 document that has no files field", () => {
    const document = { format: "branchboard", version: 1, board: { title: "Old" }, nodes: [], edges: [], parts: [], staleNodeIds: [] };
    expect(importBoardDocument(JSON.stringify(document)).title).toBe("Old (imported)");
  });

  it("drops hostile file entries and refuses an oversized total", () => {
    const good = Buffer.from("ok").toString("base64");
    const files = sanitiseFiles({
      "not-an-id": { name: "x", mime: "text/plain", base64: good },
      "11111111-1111-1111-1111-111111111111": { name: "..\\..\\evil.txt", mime: "text/plain", base64: good },
      "22222222-2222-2222-2222-222222222222": { name: "bad", mime: "text/plain", base64: "***" },
      "33333333-3333-3333-3333-333333333333": { name: "big", mime: "text/plain", base64: "A".repeat(Math.ceil(((MAX_FILE_BYTES + 3) * 4) / 3 / 4) * 4) },
      "44444444-4444-4444-4444-444444444444": "nonsense",
    });
    expect(Object.keys(files)).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(files["11111111-1111-1111-1111-111111111111"].name).toBe(".._.._evil.txt");
    expect(() => sanitiseFiles("nonsense")).toThrow();
  });

  it("refuses to export more than the cap and names the size", () => {
    const node = { id: "n", attachments: [{ id: "a", name: "a", mime: "x", size: 1 }] } as unknown as GraphNode;
    const document = { nodes: [node] } as unknown as BoardDocument;
    expect(() => embedFiles(document, { sizeOf: () => 300 * 1024 * 1024, read: () => ({ name: "a", mime: "x", base64: "" }) })).toThrow(/300\.0 MB.*150\.0 MB/);
  });
});

describe("bug report", () => {
  it("keeps secrets, prompts and home folders out of the bundle", async () => {
    const secret = `sk-ant-${"a1b2c3d4".repeat(4)}`;
    mkdirSync(join(directory, "run-logs"), { recursive: true });
    mkdirSync(join(directory, "logs"), { recursive: true });
    writeFileSync(
      join(directory, "run-logs", "b.jsonl"),
      [
        JSON.stringify({ event: "start", boardId: "b", nodeId: "n", roll: 1, input: "MY PRIVATE PROMPT" }),
        JSON.stringify({ event: "end", boardId: "b", nodeId: "n", roll: 1, status: "error", errors: [`failed with ${secret}`], input: "MY PRIVATE PROMPT" }),
      ].join("\n"),
    );
    writeFileSync(join(directory, "logs", "server.log"), `2026-01-01T00:00:00.000Z INFO  [startup] fine ${secret}\n2026-01-01T00:00:01.000Z DEBUG [command] reply (full)\n{ "prompt": "MY PRIVATE PROMPT" }\n`);
    const report = await request("/api/report");
    expect(report.status).toBe(200);
    expect(report.text).not.toContain(secret);
    expect(report.text).not.toContain("MY PRIVATE PROMPT");
    const parsed = JSON.parse(report.text);
    expect(parsed.logs["run-logs"]).toHaveLength(1);
    expect(parsed.app.version).toBeDefined();
  });
});

describe("recovery actions", () => {
  it("marks a lost session and offers to resend the context as text", async () => {
    const root = (await command({ type: "reply", boardId, prompt: "start", run: false })).json.nodeId;
    const child = (await command({ type: "reply", boardId, parentIds: [root], prompt: "/gone" })).json.nodeId;
    await waitForStatus(boardId, child, "error");
    const errorPart = (await view(boardId)).parts[child].find((part) => part.type === "error")!;
    expect(errorPart.meta?.recovery).toBe("assemble");
    expect((await command({ type: "regenerate", boardId, nodeId: child, assemble: true })).status).toBe(200);
    expect((await view(boardId)).graph.nodes[child].forceAssemble).toBe(true);
  });

  it("marks a usage limit from its wording and continues the failed node inside the same roll", async () => {
    expect(recoveryOfMessage("something else")).toBeUndefined();
    const node = (await command({ type: "reply", boardId, prompt: "/limit" })).json.nodeId;
    await waitForStatus(boardId, node, "error");
    expect((await view(boardId)).parts[node].find((part) => part.type === "error")?.meta?.recovery).toBe("usageLimit");
    const before = (await view(boardId)).graph.nodes[node];
    expect((await command({ type: "regenerate", boardId, nodeId: node, continue: true })).status).toBe(200);
    await waitForStatus(boardId, node, "done");
    const after = (await view(boardId)).graph.nodes[node];
    expect(after.rollCount).toBe(before.rollCount);
    expect(after.activeRoll).toBe(before.activeRoll);
    const parts = (await view(boardId)).parts[node];
    expect(parts.some((part) => part.type === "error")).toBe(true);
    expect(parts.some((part) => part.type === "text" && part.text.includes("Continue where you stopped."))).toBe(true);
  });
});

describe("workspace queries", () => {
  it("accepts a board, a project or an existing local folder, nothing else", async () => {
    expect((await request(`/api/runtime/catalog?board=${boardId}`)).status).toBe(200);
    expect((await request(`/api/runtime/catalog?mode=fake&project=${projectId}`)).status).toBe(200);
    expect((await request(`/api/runtime/catalog?mode=fake&workspace=${encodeURIComponent(workspace)}`)).status).toBe(200);
    expect((await request("/api/runtime/catalog?mode=fake&project=missing")).status).toBe(409);
    expect((await request("/api/runtime/catalog?mode=fake&workspace=relative%2Fpath")).status).toBe(409);
    expect((await request(`/api/runtime/catalog?mode=fake&workspace=${encodeURIComponent(join(directory, "missing"))}`)).status).toBe(409);
    expect((await request(`/api/runtime/catalog?mode=fake&workspace=${encodeURIComponent("\\\\evil\\share")}`)).status).toBe(409);
    expect((await request(`/api/health?runtime=fake&workspace=${encodeURIComponent("//evil/share")}`)).status).toBe(409);
  });
});

describe("Windows command shell quoting", () => {
  it("doubles a trailing backslash run and refuses metacharacters", () => {
    expect(quoteForCmdShell("C:\\a b\\")).toBe('"C:\\a b\\\\"');
    expect(quoteForCmdShell("C:\\a\\\\")).toBe('"C:\\a\\\\\\\\"');
    expect(quoteForCmdShell("plain")).toBe('"plain"');
    ["x!y", 'a"b', "a%b", "a&b"].forEach((value) => expect(() => quoteForCmdShell(value)).toThrow());
  });
});

describe("executable lookup", () => {
  it("never searches relative or empty PATH entries", () => {
    const seen: string[] = [];
    const result = locateExecutable(
      { overrideVariable: "NONE", names: () => ["tool"], knownDirectories: () => [] },
      { platform: "linux", env: { PATH: [".", "", "../bin", "bin", "/usr/bin"].join(delimiter) }, home: "/home/a", isFile: (path) => (seen.push(path), path === join("/usr/bin", "tool")) },
    );
    expect(result.path).toBe(join("/usr/bin", "tool"));
    expect(seen).toEqual([join("/usr/bin", "tool")]);
  });
});

describe("rendering", () => {
  it("escapes code before it reaches innerHTML", () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    for (const language of ["html", "xml", "javascript", "typescript", "python"]) {
      const html = highlightCode(hostile, language);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<script");
    }
  });

  const hastOf = async (markdown: string, allowRaw: boolean) => {
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true });
    const withRaw = allowRaw ? processor.use(rehypeRaw) : processor;
    return withRaw.use(rehypeSanitize, sanitizeSchema).run(withRaw.parse(markdown));
  };

  const collect = (node: any, found: { tag: string; properties: Record<string, unknown> }[] = []) => {
    if (node.type === "element") found.push({ tag: node.tagName, properties: node.properties ?? {} });
    (node.children ?? []).forEach((child: unknown) => collect(child, found));
    return found;
  };

  it.each([false, true])("strips scripts, handlers, style, srcset and javascript: links (raw html %s)", async (allowRaw) => {
    const markdown = [
      '<script>alert(1)</script>',
      '<img src="data:image/svg+xml;base64,AAAA" srcset="http://evil/x.png 2x" style="position:fixed" onerror="alert(1)">',
      '<a href="javascript:alert(1)" style="color:red" onclick="alert(1)">x</a>',
      '<div style="background:url(http://evil)" align="center">y</div>',
      "[js](javascript:alert(1)) [file](c:/notes/a.txt)",
    ].join("\n\n");
    const elements = collect(await hastOf(markdown, allowRaw));
    expect(elements.some((element) => element.tag === "script")).toBe(false);
    elements.forEach(({ properties }) => {
      expect(properties).not.toHaveProperty("style");
      expect(properties).not.toHaveProperty("srcSet");
      expect(properties).not.toHaveProperty("onError");
      expect(properties).not.toHaveProperty("onClick");
      expect(String(properties.href ?? "")).not.toMatch(/^javascript:/i);
      expect(String(properties.src ?? "")).not.toMatch(/^data:/i);
    });
    expect(elements.find((element) => element.tag === "a" && String(element.properties.href).startsWith("c:"))).toBeDefined();
  });
});
