import { LIST_BULLET } from "./kit/promptFormat";
import type { NodeComment } from "./types";

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

export const quotedPrompt = (text: string): string => `${text.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;

export const bulletOfQuote = (text: string): string => `${LIST_BULLET} “${collapseWhitespace(text)}”`;

const commentBlock = ({ quote, text }: Pick<NodeComment, "quote" | "text">): string =>
  [quote.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n"), text.trim()].filter((part) => part !== "").join("\n");

export const commentsPrompt = (comments: Pick<NodeComment, "quote" | "text">[]): string =>
  comments.length === 0 ? "" : `${comments.map(commentBlock).join("\n\n")}\n\n`;

export const isBranchList = (prompt: string): boolean => prompt.trimStart().startsWith(`${LIST_BULLET} `);

export const withAddedBullet = (prompt: string, text: string): string => `${prompt.replace(/\s+$/, "")}\n${bulletOfQuote(text)}`;
