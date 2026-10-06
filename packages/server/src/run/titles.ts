import { askOnce } from "./askOnce";
import type { RunScope, RuntimeSteps } from "./types";

const TITLE_TIMEOUT_MS = 45000;
const MAX_TITLE_CHARS = 32;
const MAX_PROMPT_CHARS = 1500;

export interface TitleRequest {
  runtime: RuntimeSteps;
  scope: Pick<RunScope, "boardId" | "nodeId" | "workspacePath" | "agent" | "model">;
  prompt: string;
  subject?: TitleSubject;
}

export type TitleSubject = "chat" | "board";

const SUBJECT_LABELS: Record<TitleSubject, string> = { chat: "conversation turn", board: "conversation, as the name of a board about its topic" };

export const titleInstruction = (prompt: string, subject: TitleSubject = "chat"): string =>
  [
    `Write a title of 2 to 3 words for the ${SUBJECT_LABELS[subject]} below. Do not use any tools.`,
    "Reply with the title only: no quotes, no punctuation at the end, no explanation.",
    "",
    "User:",
    prompt.slice(0, MAX_PROMPT_CHARS),
  ].join("\n");

export const cleanTitle = (raw: string): string | undefined => {
  const firstLine = raw.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const stripped = firstLine
    .replace(/^(title|name)\s*:\s*/i, "")
    .replace(/^[#>*\-\s"'`“”‘’]+|["'`“”‘’*\s.]+$/g, "")
    .replace(/\s+/g, " ");
  if (!stripped) return undefined;
  return stripped.length > MAX_TITLE_CHARS ? `${stripped.slice(0, MAX_TITLE_CHARS).trimEnd()}…` : stripped;
};

const FALLBACK_WORDS = 3;

export const shortName = (text: string): string | undefined => cleanTitle(text.trim().split(/\s+/).slice(0, FALLBACK_WORDS).join(" "));

export const suggestTitle = async ({ runtime, scope, prompt, subject }: TitleRequest): Promise<{ title?: string; input: string; output: string }> => {
  const input = titleInstruction(prompt, subject);
  const output = await askOnce({ runtime, scope, input, purpose: "title", timeoutMs: TITLE_TIMEOUT_MS });
  return { title: cleanTitle(output), input, output };
};
