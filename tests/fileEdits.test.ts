import { describe, expect, it } from "vitest";
import { preferredModelId } from "@branchboard/core";

describe("preferred model", () => {
  const models = [{ id: "default" }, { id: "sonnet" }, { id: "claude-sonnet-5-5" }, { id: "opus" }];

  it("prefers an exact id, then a partial match", () => {
    expect(preferredModelId(models, "sonnet")).toBe("sonnet");
    expect(preferredModelId([{ id: "anthropic/claude-sonnet-5-5" }], "sonnet")).toBe("anthropic/claude-sonnet-5-5");
    expect(preferredModelId(models, "gemini")).toBeUndefined();
    expect(preferredModelId(models, " ")).toBeUndefined();
  });
});
