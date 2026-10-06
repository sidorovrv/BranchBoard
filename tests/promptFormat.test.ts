import { describe, expect, it } from "vitest";
import { autoFormatTyped, bulletOfQuote, isBranchList, nodeTintOf, normalizePastedLists, quotedPrompt, splitPromptSegments, withAddedBullet } from "@branchboard/core";

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

  it("splits a prompt into text and code segments", () => {
    expect(splitPromptSegments("intro\n```ts\nconst a = 1;\n```\n\n• tail")).toEqual([
      { kind: "text", text: "intro" },
      { kind: "code", text: "const a = 1;", language: "ts" },
      { kind: "text", text: "• tail" },
    ]);
    expect(splitPromptSegments("```\nopen")).toEqual([{ kind: "code", text: "open", language: undefined }]);
    expect(splitPromptSegments("plain")).toEqual([{ kind: "text", text: "plain" }]);
  });

  it("normalises pasted markdown bullets outside code fences", () => {
    expect(normalizePastedLists("- a\n  * b\n```\n- keep\n```\n+ c")).toBe("• a\n  • b\n```\n- keep\n```\n• c");
  });
});

describe("branch from selection helpers", () => {
  it("builds quotes, bullets and appends to branch lists", () => {
    expect(quotedPrompt("one\ntwo")).toBe("> one\n> two\n\n");
    expect(bulletOfQuote("  a   b\nc ")).toBe("• “a b c”");
    expect(isBranchList("• “x”")).toBe(true);
    expect(isBranchList("plain")).toBe(false);
    expect(withAddedBullet("• “x”\n", "y")).toBe("• “x”\n• “y”");
  });
});

describe("node tint", () => {
  it("keeps a thread's colour, relates branches to it and separates siblings", () => {
    const root = nodeTintOf("Planning");
    expect(nodeTintOf("planning")).toEqual(root);
    const branches = ["Planning › Costs", "Planning › Risks", "Planning › Timeline", "Planning › Staffing"].map(nodeTintOf);
    branches.forEach((tint) => expect(tint).not.toEqual(root));
    branches.forEach((tint) => expect(Math.abs(((tint.hue - root.hue + 540) % 360) - 180)).toBeLessThanOrEqual(26));
    expect(new Set(branches.map((tint) => `${tint.hue}/${tint.tone}`)).size).toBeGreaterThan(1);
    expect(nodeTintOf("Planning › Costs")).toEqual(nodeTintOf("Planning › Costs"));
  });
});
