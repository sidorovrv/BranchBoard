import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isReadableText, unsentFileNotes } from "../packages/server/src/run/fileChecks";

const directory = mkdtempSync(join(tmpdir(), "branchboard-files-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const fileOf = (name: string, mime: string, content: Buffer | string) => {
  const path = join(directory, name);
  writeFileSync(path, content);
  return { name, mime, path };
};

describe("files the engine would not send", () => {
  it("reads only valid UTF-8 without NUL bytes as text", () => {
    expect(isReadableText(Buffer.from("café\n"))).toBe(true);
    expect(isReadableText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(false);
    expect(isReadableText(Buffer.from("ab\0cd"))).toBe(false);
  });

  it("names an image or a PDF that the model does not accept", () => {
    const image = fileOf("a.png", "image/png", "x");
    const pdf = fileOf("a.pdf", "application/pdf", "x");
    expect(unsentFileNotes([image, pdf], ["text"])).toEqual(["a.png was not sent: the model does not accept image files.", "a.pdf was not sent: the model does not accept pdf files."]);
    expect(unsentFileNotes([image, pdf], ["text", "image", "pdf"])).toEqual([]);
    expect(unsentFileNotes([image, pdf], undefined)).toEqual([]);
  });

  it("names a file that is neither text nor media, whatever its type says", () => {
    const archive = fileOf("a.zip", "application/zip", Buffer.from([0x50, 0x4b, 0, 0xff]));
    const code = fileOf("b.ts", "video/mp2t", "export const a = 1;\n");
    expect(unsentFileNotes([archive, code], ["text"])).toEqual(["a.zip was not sent: it is not UTF-8 text, an image or a PDF."]);
  });
});
