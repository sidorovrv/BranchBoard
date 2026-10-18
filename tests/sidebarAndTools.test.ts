import { describe, expect, it } from "vitest";
import { applyOrder, moveWithin } from "@branchboard/core";

describe("sidebar ordering", () => {
  const items = ["a", "b", "c", "d"].map((id) => ({ id }));

  it("puts unlisted items first or last and drops unknown ids", () => {
    expect(applyOrder(items, ["c", "x", "a"], true).map((item) => item.id)).toEqual(["b", "d", "c", "a"]);
    expect(applyOrder(items, ["c", "a"], false).map((item) => item.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("moves an id before or after a target", () => {
    expect(moveWithin(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(moveWithin(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(moveWithin(["a", "b", "c"], "a", "a", "after")).toEqual(["a", "b", "c"]);
    expect(moveWithin(["a", "b", "c"], "z", "a", "after")).toEqual(["a", "b", "c"]);
  });
});
