import { COMMAND_TYPE_HEADER } from "@branchboard/core";
import { RefusedError } from "./boards";

const MEGABYTE = 1024 * 1024;

export const BODY_CAPS = {
  commands: 2 * MEGABYTE,
  importBoard: 256 * MEGABYTE,
  attachments: 25 * MEGABYTE,
  mcp: 1 * MEGABYTE,
  perf: 16 * 1024,
} as const;

export type BodyKind = "json" | "bytes";

export const commandCapOf = (request: Request): number =>
  request.headers.get(COMMAND_TYPE_HEADER) === "importBoard" ? BODY_CAPS.importBoard : BODY_CAPS.commands;

const readBytes = async (request: Request, maxBytes: number): Promise<Uint8Array> => {
  const limitLabel = maxBytes >= MEGABYTE ? `${maxBytes / MEGABYTE} MB` : `${maxBytes / 1024} KB`;
  const tooLarge = () => new RefusedError(`The request is larger than ${limitLabel}`);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  chunks.reduce((offset, chunk) => (bytes.set(chunk, offset), offset + chunk.byteLength), 0);
  return bytes;
};

export async function readCappedBody(request: Request, maxBytes: number, kind: "bytes"): Promise<Uint8Array>;
export async function readCappedBody(request: Request, maxBytes: number, kind: "json"): Promise<unknown>;
export async function readCappedBody(request: Request, maxBytes: number, kind: BodyKind): Promise<unknown> {
  const bytes = await readBytes(request, maxBytes);
  return kind === "bytes" ? bytes : JSON.parse(new TextDecoder().decode(bytes));
}
