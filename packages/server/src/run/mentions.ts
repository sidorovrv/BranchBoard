import { statSync } from "node:fs";
import { basename } from "node:path";
import { mentionTokensOf } from "@branchboard/core";
import { MAX_ATTACHMENT_BYTES } from "../attachments";
import { existingWorkspaceFile, isSensitiveWorkspaceFile, mimeOfPath } from "../workspaceFiles";
import type { RunFile } from "./types";

const fileOfMention = (workspacePath: string, token: string): RunFile | undefined => {
  const path = existingWorkspaceFile(workspacePath, token);
  if (!path || statSync(path).size > MAX_ATTACHMENT_BYTES) return undefined;
  return { name: basename(path), mime: mimeOfPath(path), path };
};

export const sensitiveMentionsOf = (prompt: string, workspacePath: string): string[] =>
  mentionTokensOf(prompt).filter((token) => {
    const path = existingWorkspaceFile(workspacePath, token);
    return path !== undefined && isSensitiveWorkspaceFile(workspacePath, token, path);
  });

export interface MentionTargets {
  agents: string[];
  subagents?: string[];
  skills?: string[];
}

export interface ResolvedMentions {
  files: RunFile[];
  agent?: string;
  subagents: string[];
  skills: string[];
}

export const resolveMentions = (prompt: string, workspacePath: string, targets: MentionTargets): ResolvedMentions => {
  const tokens = mentionTokensOf(prompt);
  const agent = tokens.find((token) => targets.agents.includes(token));
  const subagents = tokens.filter((token) => targets.subagents?.includes(token));
  const skills = tokens.filter((token) => targets.skills?.includes(token));
  const named = new Set([agent, ...subagents, ...skills]);
  const files = tokens
    .filter((token) => !named.has(token))
    .map((token) => fileOfMention(workspacePath, token))
    .filter((file): file is RunFile => file !== undefined);
  const unique = new Map(files.map((file) => [file.path, file]));
  return { files: [...unique.values()], agent, subagents: [...new Set(subagents)], skills: [...new Set(skills)] };
};
