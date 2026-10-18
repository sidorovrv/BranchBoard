import { describe, expect, it } from "vitest";
import { autoFormatTyped, highlightSpans, normalizePastedLists } from "./promptFormat";

const typeAt = (before: string, caret: number, character: string) => {
  const text = before.slice(0, caret) + character + before.slice(caret);
  return autoFormatTyped(before, text, caret + 1);
};

describe("prompt auto formatting", () => {
  it("turns a typed dash marker into a mid-size dot", () => {
    expect(typeAt("-", 1, " ")).toEqual({ text: "• ", caret: 2 });
    expect(typeAt("intro\n  *", 9, " ")).toEqual({ text: "intro\n  • ", caret: 10 });
  });

  it("leaves a dash inside a sentence or a code block alone", () => {
    expect(typeAt("a -", 3, " ")).toBeUndefined();
    expect(typeAt("```\n-", 5, " ")).toBeUndefined();
  });

  it("continues a bullet list on Enter and ends it on an empty bullet", () => {
    expect(typeAt("• one", 5, "\n")).toEqual({ text: "• one\n• ", caret: 8 });
    expect(typeAt("• one\n• ", 8, "\n")).toEqual({ text: "• one\n", caret: 6 });
  });

  it("continues numbered lists with the next number", () => {
    expect(typeAt("1. one", 6, "\n")).toEqual({ text: "1. one\n2. ", caret: 10 });
  });

  it("closes a code fence when Enter follows the opening fence", () => {
    expect(typeAt("```ts", 5, "\n")).toEqual({ text: "```ts\n\n```", caret: 6 });
    expect(typeAt("```ts\ncode\n```", 5, "\n")).toBeUndefined();
  });

  it("ignores edits that are not a single typed character", () => {
    expect(autoFormatTyped("-", "- x ", 4)).toBeUndefined();
  });

  it("normalises pasted markdown bullets outside code fences", () => {
    expect(normalizePastedLists("- a\n  * b\n```\n- keep\n```\n+ c")).toBe("• a\n  • b\n```\n- keep\n```\n• c");
  });

  it("marks inline code and fenced code", () => {
    expect(highlightSpans("use `x` now").map((span) => span.kind)).toEqual(["plain", "inline-code", "plain"]);
    expect(highlightSpans("```\ncode\n```").map((span) => span.kind)).toEqual(["fence-line", "plain", "block-code", "plain", "fence-line"]);
  });
});
