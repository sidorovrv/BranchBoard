export interface FormattedText {
  text: string;
  caret: number;
}

export const LIST_BULLET = "•";

const BULLET_TRIGGER = /^(\s*)[-*+] $/;
const BULLET_LINE = /^(\s*)• (.*)$/;
const NUMBER_LINE = /^(\s*)(\d+)\. (.*)$/;
const MARKDOWN_BULLET_LINE = /^(\s*)[-*+] (.*)$/;
const FENCE_LINE = /^\s*```/;
const FENCE_OPENER = /^\s*```[\w+#.-]*$/;

const lineStartOf = (text: string, index: number): number => text.lastIndexOf("\n", index - 1) + 1;

const fenceCount = (text: string): number => text.split("\n").filter((line) => FENCE_LINE.test(line)).length;

const isInsideFence = (text: string, index: number): boolean => fenceCount(text.slice(0, index)) % 2 === 1;

const continuationOf = (line: string): { prefix: string; isEmpty: boolean } | undefined => {
  const bullet = BULLET_LINE.exec(line);
  if (bullet) return { prefix: `${bullet[1]}${LIST_BULLET} `, isEmpty: bullet[2].trim() === "" };
  const numbered = NUMBER_LINE.exec(line);
  if (numbered) return { prefix: `${numbered[1]}${Number(numbered[2]) + 1}. `, isEmpty: numbered[3].trim() === "" };
  return undefined;
};

const insertAt = (text: string, index: number, inserted: string): string => text.slice(0, index) + inserted + text.slice(index);

const bulletFromMarker = (text: string, caret: number): FormattedText | undefined => {
  const lineStart = lineStartOf(text, caret - 1);
  const marker = BULLET_TRIGGER.exec(text.slice(lineStart, caret));
  if (!marker || isInsideFence(text, lineStart)) return undefined;
  return { text: `${text.slice(0, lineStart)}${marker[1]}${LIST_BULLET} ${text.slice(caret)}`, caret };
};

const continuedList = (text: string, caret: number): FormattedText | undefined => {
  const previousLineStart = lineStartOf(text, caret - 1);
  if (isInsideFence(text, previousLineStart)) return undefined;
  const continuation = continuationOf(text.slice(previousLineStart, caret - 1));
  if (!continuation) return undefined;
  if (continuation.isEmpty) return { text: text.slice(0, previousLineStart) + text.slice(caret), caret: previousLineStart };
  return { text: insertAt(text, caret, continuation.prefix), caret: caret + continuation.prefix.length };
};

const closedFence = (text: string, caret: number): FormattedText | undefined => {
  const previousLineStart = lineStartOf(text, caret - 1);
  if (!FENCE_OPENER.test(text.slice(previousLineStart, caret - 1)) || fenceCount(text) % 2 === 0) return undefined;
  const rest = text.slice(caret);
  const closing = rest === "" || rest.startsWith("\n") ? "\n```" : "\n```\n";
  return { text: insertAt(text, caret, closing), caret };
};

const typedCharacter = (previous: string, text: string, caret: number): string | undefined => {
  if (text.length !== previous.length + 1 || caret < 1) return undefined;
  return text.slice(0, caret - 1) + text.slice(caret) === previous ? text[caret - 1] : undefined;
};

export const autoFormatTyped = (previous: string, text: string, caret: number): FormattedText | undefined => {
  const typed = typedCharacter(previous, text, caret);
  if (typed === " ") return bulletFromMarker(text, caret);
  if (typed === "\n") return closedFence(text, caret) ?? continuedList(text, caret);
  return undefined;
};

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

export const quotedPrompt = (text: string): string => `${text.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;

export const bulletOfQuote = (text: string): string => `${LIST_BULLET} “${collapseWhitespace(text)}”`;

export const isBranchList = (prompt: string): boolean => prompt.trimStart().startsWith(`${LIST_BULLET} `);

export const withAddedBullet = (prompt: string, text: string): string => `${prompt.replace(/\s+$/, "")}\n${bulletOfQuote(text)}`;

export interface PromptSegment {
  kind: "text" | "code";
  text: string;
  language?: string;
}

const FENCE_WITH_LANGUAGE = /^\s*```([\w+#.-]*)\s*$/;

const trimBlankEdges = (text: string): string => text.replace(/^\n+|\n+$/g, "");

export const splitPromptSegments = (prompt: string): PromptSegment[] => {
  const segments: PromptSegment[] = [];
  let current: { segment: PromptSegment; lines: string[] } | undefined;
  const close = () => {
    if (current) segments.push({ ...current.segment, text: current.segment.kind === "text" ? trimBlankEdges(current.lines.join("\n")) : current.lines.join("\n") });
    current = undefined;
  };
  for (const line of prompt.split("\n")) {
    const opener = current?.segment.kind === "code" ? undefined : FENCE_WITH_LANGUAGE.exec(line);
    if (opener) {
      close();
      current = { segment: { kind: "code", text: "", language: opener[1] || undefined }, lines: [] };
    } else if (current?.segment.kind === "code" && line.trim() === "```") close();
    else {
      current ??= { segment: { kind: "text", text: "" }, lines: [] };
      current.lines.push(line);
    }
  }
  close();
  return segments.filter((segment) => segment.kind === "code" || segment.text.trim() !== "");
};

export interface HighlightSpan {
  kind: "plain" | "inline-code" | "block-code" | "fence-line";
  text: string;
}

const INLINE_CODE = /`[^`\n]+`/g;

const inlineSpans = (line: string): HighlightSpan[] => {
  const spans: HighlightSpan[] = [];
  let cursor = 0;
  for (const match of line.matchAll(INLINE_CODE)) {
    if (match.index > cursor) spans.push({ kind: "plain", text: line.slice(cursor, match.index) });
    spans.push({ kind: "inline-code", text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) spans.push({ kind: "plain", text: line.slice(cursor) });
  return spans;
};

export const highlightSpans = (text: string): HighlightSpan[] => {
  const spans: HighlightSpan[] = [];
  let isInFence = false;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const lineBreak = index < lines.length - 1 ? "\n" : "";
    const isFenceLine = FENCE_WITH_LANGUAGE.test(line);
    if (isFenceLine) spans.push({ kind: "fence-line", text: line });
    else if (isInFence) spans.push({ kind: "block-code", text: line });
    else spans.push(...inlineSpans(line));
    if (isFenceLine) isInFence = !isInFence;
    if (lineBreak) spans.push({ kind: "plain", text: lineBreak });
  });
  return spans;
};

export const normalizePastedLists =(text: string): string => {
  let isInFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) isInFence = !isInFence;
      const marker = isInFence ? null : MARKDOWN_BULLET_LINE.exec(line);
      return marker ? `${marker[1]}${LIST_BULLET} ${marker[2]}` : line;
    })
    .join("\n");
};
