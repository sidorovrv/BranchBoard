import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { isSensitivePath, mentionTokensOf } from "@branchboard/core";
import { MAX_ATTACHMENT_BYTES } from "../attachments";
import { existingWorkspaceFile, mimeOfPath } from "../workspaceFiles";
import type { RunFile } from "./types";

const fileOfMention = (workspacePath: string, token: string): RunFile | undefined => {
  const path = existingWorkspaceFile(workspacePath, token);
  if (!path || statSync(path).size > MAX_ATTACHMENT_BYTES) return undefined;
  return { name: basename(path), mime: mimeOfPath(path), path };
};

export const sensitiveMentionsOf = (prompt: string, workspacePath: string): string[] =>
  mentionTokensOf(prompt).filter((token) => {
    const path = existingWorkspaceFile(workspacePath, token);
    return path !== undefined && (isSensitivePath(token) || isSensitivePath(realpathSync(path)));
  });

export interface ResolvedMentions {
  files: RunFile[];
  agent?: string;
}

export const resolveMentions = (prompt: string, workspacePath: string, agents: string[]): ResolvedMentions => {
  const tokens = mentionTokensOf(prompt);
  const agent = tokens.find((token) => agents.includes(token));
  const files = tokens
    .filter((token) => token !== agent)
    .map((token) => fileOfMention(workspacePath, token))
    .filter((file): file is RunFile => file !== undefined);
  const unique = new Map(files.map((file) => [file.path, file]));
  return { files: [...unique.values()], agent };
};
