import type { DragEvent } from "react";
import type { Attachment, Id } from "@branchboard/core";
import { uploadAttachment } from "./api";
import { boardId, sendBoardCommand, useBoard } from "./store";

const uploadAll = async (files: File[]): Promise<Id[] | undefined> => {
  if (files.length === 0) return undefined;
  try {
    const stored = await Promise.all(files.map((file) => uploadAttachment(boardId(), file)));
    return stored.map((attachment) => attachment.id);
  } catch (error) {
    useBoard.getState().notify(error instanceof Error ? error.message : String(error));
    return undefined;
  }
};

export const attachToNode = async (nodeId: Id, files: File[]) => {
  const attachmentIds = await uploadAll(files);
  if (attachmentIds) await sendBoardCommand({ type: "attach", nodeId, attachmentIds });
};

export const createFileNode = async (files: File[], position?: { x: number; y: number }) => {
  const attachmentIds = await uploadAll(files);
  if (!attachmentIds) return;
  const created = await sendBoardCommand<{ nodeId: Id }>({ type: "file", attachmentIds, position });
  if (created) useBoard.getState().requestFocus(created.nodeId);
};

export const detachFromNode = (nodeId: Id, attachmentId: Id) => sendBoardCommand({ type: "detach", nodeId, attachmentId });

export const pickFiles = (): Promise<File[]> =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });

export const hasFiles = (event: DragEvent): boolean => event.dataTransfer.types.includes("Files");

export const droppedFiles = (event: DragEvent): File[] => [...event.dataTransfer.files];

export const pastedFiles = (event: ClipboardEvent): File[] => [...(event.clipboardData?.files ?? [])];

export const pasteFiles = async (files: File[], newNodePosition: { x: number; y: number }) => {
  const { selectedIds, view } = useBoard.getState();
  const target = selectedIds.length === 1 ? view.graph.nodes[selectedIds[0]] : undefined;
  if (target && target.kind !== "context" && target.kind !== "subagent") await attachToNode(target.id, files);
  else await createFileNode(files, newNodePosition);
};

const DISPLAYABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const isDisplayableImage = (attachment: Attachment): boolean => DISPLAYABLE_IMAGE_TYPES.includes(attachment.mime);

export const fileTypeLabel = (attachment: Attachment): string => (attachment.name.includes(".") ? attachment.name.split(".").pop()!.toUpperCase() : "FILE");

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
