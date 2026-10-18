import { readFileSync } from "node:fs";
import type { RunFile } from "./types";

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export const isReadableText = (bytes: Uint8Array): boolean => {
  if (bytes.includes(0)) return false;
  try {
    strictDecoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

const MEDIA_KINDS = [
  { kind: "image", matches: (mime: string) => mime.startsWith("image/") },
  { kind: "pdf", matches: (mime: string) => mime === "application/pdf" },
];

export const unsentFileNotes = (files: RunFile[], acceptedMedia: string[] | undefined): string[] =>
  files.flatMap((file) => {
    const media = MEDIA_KINDS.find((candidate) => candidate.matches(file.mime));
    if (media) return acceptedMedia && !acceptedMedia.includes(media.kind) ? [`${file.name} was not sent: the model does not accept ${media.kind} files.`] : [];
    const bytes = (() => {
      try {
        return readFileSync(file.path);
      } catch {
        return undefined;
      }
    })();
    return bytes && !isReadableText(bytes) ? [`${file.name} was not sent: it is not UTF-8 text, an image or a PDF.`] : [];
  });
