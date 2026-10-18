import { FENCE_WITH_LANGUAGE } from "./promptSegments";

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
const INLINE_CODE = /`[^`\n]+`/g;

const lineStartOf = (text: string, index: number) => text.lastIndexOf("\n", index - 1) + 1;

const fenceCount = (text: string) =>
  text.split("\n").filter((line) => FENCE_LINE.test(line)).length;

const isInsideFence = (text: string, index: number) => fenceCount(text.slice(0, index)) % 2 === 1;

const insertAt = (text: string, index: number, inserted: string) =>
  text.slice(0, index) + inserted + text.slice(index);

function continuationOf(line: string): { prefix: string; isEmpty: boolean } | undefined {
  const bullet = BULLET_LINE.exec(line);
  if (bullet)
    return { prefix: `${bullet[1]}${LIST_BULLET} `, isEmpty: (bullet[2] ?? "").trim() === "" };
  const numbered = NUMBER_LINE.exec(line);
  if (numbered)
    return {
      prefix: `${numbered[1]}${Number(numbered[2]) + 1}. `,
      isEmpty: (numbered[3] ?? "").trim() === "",
    };
  return undefined;
}

function bulletFromMarker(text: string, caret: number): FormattedText | undefined {
  const lineStart = lineStartOf(text, caret - 1);
  const marker = BULLET_TRIGGER.exec(text.slice(lineStart, caret));
  if (!marker || isInsideFence(text, lineStart)) return undefined;
  return {
    text: `${text.slice(0, lineStart)}${marker[1]}${LIST_BULLET} ${text.slice(caret)}`,
    caret,
  };
}

function continuedList(text: string, caret: number): FormattedText | undefined {
  const previousLineStart = lineStartOf(text, caret - 1);
  if (isInsideFence(text, previousLineStart)) return undefined;
  const continuation = continuationOf(text.slice(previousLineStart, caret - 1));
  if (!continuation) return undefined;
  if (continuation.isEmpty)
    return { text: text.slice(0, previousLineStart) + text.slice(caret), caret: previousLineStart };
  return {
    text: insertAt(text, caret, continuation.prefix),
    caret: caret + continuation.prefix.length,
  };
}

function closedFence(text: string, caret: number): FormattedText | undefined {
  const previousLineStart = lineStartOf(text, caret - 1);
  if (!FENCE_OPENER.test(text.slice(previousLineStart, caret - 1)) || fenceCount(text) % 2 === 0)
    return undefined;
  const rest = text.slice(caret);
  const closing = rest === "" || rest.startsWith("\n") ? "\n```" : "\n```\n";
  return { text: insertAt(text, caret, closing), caret };
}

function typedCharacter(previous: string, text: string, caret: number): string | undefined {
  if (text.length !== previous.length + 1 || caret < 1) return undefined;
  return text.slice(0, caret - 1) + text.slice(caret) === previous ? text[caret - 1] : undefined;
}

export function autoFormatTyped(
  previous: string,
  text: string,
  caret: number,
): FormattedText | undefined {
  const typed = typedCharacter(previous, text, caret);
  if (typed === " ") return bulletFromMarker(text, caret);
  if (typed === "\n") return closedFence(text, caret) ?? continuedList(text, caret);
  return undefined;
}

export function normalizePastedLists(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) inFence = !inFence;
      const marker = inFence ? null : MARKDOWN_BULLET_LINE.exec(line);
      return marker ? `${marker[1]}${LIST_BULLET} ${marker[2]}` : line;
    })
    .join("\n");
}

export interface HighlightSpan {
  kind: "plain" | "inline-code" | "block-code" | "fence-line";
  text: string;
}

function inlineSpans(line: string): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  let cursor = 0;
  for (const match of line.matchAll(INLINE_CODE)) {
    if (match.index > cursor) spans.push({ kind: "plain", text: line.slice(cursor, match.index) });
    spans.push({ kind: "inline-code", text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) spans.push({ kind: "plain", text: line.slice(cursor) });
  return spans;
}

export function highlightSpans(text: string): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  let inFence = false;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const lineBreak = index < lines.length - 1 ? "\n" : "";
    const isFenceLine = FENCE_WITH_LANGUAGE.test(line);
    if (isFenceLine) spans.push({ kind: "fence-line", text: line });
    else if (inFence) spans.push({ kind: "block-code", text: line });
    else spans.push(...inlineSpans(line));
    if (isFenceLine) inFence = !inFence;
    if (lineBreak) spans.push({ kind: "plain", text: lineBreak });
  });
  return spans;
}
