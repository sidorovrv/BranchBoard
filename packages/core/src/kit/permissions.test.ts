import { describe, expect, it } from "vitest";
import { DEFAULT_PERMISSION_PRESET, PERMISSION_PRESETS, presetRules } from "./permissions";

describe("permission presets", () => {
  it("covers the Claude mode ids", () => {
    expect(PERMISSION_PRESETS.map((preset) => preset.id)).toEqual(["manual", "plan", "acceptEdits", "auto", "dontAsk"]);
    expect(presetRules(DEFAULT_PERMISSION_PRESET)).toContainEqual({ action: "edit", resource: "*", effect: "allow" });
    expect(presetRules("plan")).toContainEqual({ action: "edit", resource: "*", effect: "deny" });
    expect(presetRules("dontAsk")).toContainEqual({ action: "shell", resource: "*", effect: "deny" });
    expect(presetRules("manual")).toContainEqual({ action: "shell", resource: "*", effect: "ask" });
    expect(presetRules("unknown")).toBeUndefined();
  });

  it("denies reading .env files in every mode", () => {
    PERMISSION_PRESETS.forEach((preset) => expect(preset.rules).toContainEqual({ action: "read", resource: "*.env", effect: "deny" }));
  });
});
