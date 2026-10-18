import { describe, expect, it } from "vitest";
import { parseTodoItems, todoProgress } from "./todos";

describe("todo items", () => {
  it("parses todo items from the shapes the runtimes send", () => {
    expect(parseTodoItems([{ content: "a", status: "pending" }, { activeForm: "b", status: "in-progress" }, { content: " ", status: "pending" }, { content: "c", status: "cancelled" }])).toEqual([
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" },
    ]);
    expect(parseTodoItems("nope")).toEqual([]);
  });

  it("counts completed items out of all items", () => {
    expect(todoProgress([{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "completed" }])).toEqual({ done: 2, total: 3 });
    expect(todoProgress([])).toEqual({ done: 0, total: 0 });
  });
});
