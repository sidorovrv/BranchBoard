import { describe, expect, it } from "vitest";
import { isLongPrompt, splitPromptSegments } from "./promptSegments";

describe("prompt segments", () => {
  it("splits a prompt at code fences", () => {
    expect(splitPromptSegments("Run:\n```sql\nselect 1\n```\nDone")).toEqual([
      { kind: "text", text: "Run:" },
      { kind: "code", text: "select 1", language: "sql" },
      { kind: "text", text: "Done" },
    ]);
  });

  it("detects long prompts by lines, characters and fences", () => {
    expect(isLongPrompt("short", 6)).toBe(false);
    expect(isLongPrompt("a\nb\nc", 2)).toBe(true);
    expect(isLongPrompt("x".repeat(321), 6)).toBe(true);
    expect(isLongPrompt("```\nx\n```", 6)).toBe(true);
  });
});
