import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Attachment } from "@branchboard/core";
import { RefusedError } from "./boards";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ID_PATTERN = /^[0-9a-f-]{36}$/;
const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const FALLBACK_MIME = "application/octet-stream";
const MAX_NAME_LENGTH = 200;

const cleanName = (name: string): string => name.replace(/[\\/\0]/g, "_").slice(0, MAX_NAME_LENGTH) || "file";

export const createAttachmentStore = (directory: string) => {
  mkdirSync(directory, { recursive: true });
  const dataPath = (id: string) => join(directory, id);
  const metaPath = (id: string) => join(directory, `${id}.json`);

  const describe = (id: string): Attachment => {
    if (!ID_PATTERN.test(id) || !existsSync(metaPath(id))) throw new RefusedError("That attachment no longer exists");
    return JSON.parse(readFileSync(metaPath(id), "utf8")) as Attachment;
  };

  const save = (name: string, mime: string, bytes: Uint8Array): Attachment => {
    if (bytes.byteLength === 0) throw new RefusedError("That file is empty");
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new RefusedError(`That file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    const attachment: Attachment = { id: newId(), name: cleanName(name), mime: mime || FALLBACK_MIME, size: bytes.byteLength };
    writeFileSync(dataPath(attachment.id), bytes);
    writeFileSync(metaPath(attachment.id), JSON.stringify(attachment));
    return attachment;
  };

  const servedMime = (attachment: Attachment): string => (INLINE_IMAGE_TYPES.includes(attachment.mime) ? attachment.mime : FALLBACK_MIME);

  const listStored = (): { id: string; modifiedAt: number }[] =>
    readdirSync(directory)
      .filter((file) => ID_PATTERN.test(file))
      .map((id) => ({ id, modifiedAt: statSync(dataPath(id)).mtimeMs }));

  const remove = (id: string) => {
    if (!ID_PATTERN.test(id)) return;
    rmSync(dataPath(id), { force: true });
    rmSync(metaPath(id), { force: true });
  };

  return {
    listStored,
    remove,
    save,
    describe,
    describeAll: (ids: string[]) => ids.map(describe),
    read: (id: string) => ({ attachment: describe(id), bytes: readFileSync(dataPath(id)) }),
    pathOf: (id: string) => dataPath(describe(id).id),
    servedMime,
    isInline: (attachment: Attachment) => INLINE_IMAGE_TYPES.includes(attachment.mime),
  };
};

export type AttachmentStore = ReturnType<typeof createAttachmentStore>;
