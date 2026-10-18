import { describe, expect, it } from "vitest";
import { environmentTextOf, MAX_ENVIRONMENT_VARIABLES, parseEnvironmentText } from "@branchboard/core";

describe("environment variables", () => {
  it("reads NAME=value lines and skips blanks and comments", () => {
    expect(parseEnvironmentText("A=1\n\n# note\nB = two words\nC=x=y\r\nD=")).toEqual({ A: "1", B: " two words", C: "x=y", D: "" });
  });

  it("refuses bad names, reserved names and oversized input", () => {
    expect(() => parseEnvironmentText("1A=x")).toThrow("not a valid variable name");
    expect(() => parseEnvironmentText("my var=x")).toThrow("not a valid variable name");
    expect(() => parseEnvironmentText("path=/tmp")).toThrow("cannot be set");
    expect(() => parseEnvironmentText(`A=${"x".repeat(4001)}`)).toThrow("not allowed");
    expect(() => parseEnvironmentText(Array.from({ length: MAX_ENVIRONMENT_VARIABLES + 1 }, (_, index) => `V${index}=1`).join("\n"))).toThrow("At most");
  });

  it("writes the variables back as lines", () => {
    expect(environmentTextOf({ A: "1", B: "2" })).toBe("A=1\nB=2");
    expect(environmentTextOf(undefined)).toBe("");
  });
});
