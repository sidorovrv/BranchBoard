import { describe, expect, it } from "vitest";
import { isRepeatedToolName, toolInputView } from "@branchboard/core";

describe("toolInputView", () => {
  it("picks the sql field and collapses its whitespace for the summary", () => {
    const view = toolInputView({ sql: "select\n    count(*) n_rows\nfrom main.runs" });
    expect(view?.primaryKey).toBe("sql");
    expect(view?.summary).toBe("select count(*) n_rows from main.runs");
    expect(view?.primaryText).toContain("\n");
    expect(view?.remaining).toBeUndefined();
  });

  it("keeps the other fields as remaining", () => {
    expect(toolInputView({ command: "ls", timeout: 5 })?.remaining).toEqual({ timeout: 5 });
  });

  it("falls back to a lone string field and refuses inputs without one", () => {
    expect(toolInputView({ anything: "text" })?.primaryKey).toBe("anything");
    expect(toolInputView({ a: "x", b: "y" })).toBeUndefined();
    expect(toolInputView(["x"])).toBeUndefined();
    expect(toolInputView(undefined)).toBeUndefined();
  });

  it("detects a label that only repeats the tool name", () => {
    expect(isRepeatedToolName("sql_query", "sql_query")).toBe(true);
    expect(isRepeatedToolName("", "sql_query")).toBe(true);
    expect(isRepeatedToolName("src/app.ts", "Read")).toBe(false);
  });
});
