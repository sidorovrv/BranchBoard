import { describe, expect, it } from "vitest";
import { bulletOfQuote, isBranchList, nodeTintOf, quotedPrompt, splitPromptSegments, withAddedBullet } from "@branchboard/core";

describe("prompt segments", () => {
  it("splits a prompt into text and code segments, an unclosed fence included", () => {
    expect(splitPromptSegments("intro\n```ts\nconst a = 1;\n```\n\n• tail")).toEqual([
      { kind: "text", text: "intro" },
      { kind: "code", text: "const a = 1;", language: "ts" },
      { kind: "text", text: "• tail" },
    ]);
    expect(splitPromptSegments("```\nopen")).toEqual([{ kind: "code", text: "open", language: undefined }]);
    expect(splitPromptSegments("plain")).toEqual([{ kind: "text", text: "plain" }]);
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
