import { describe, expect, it } from "vitest";
import { commandWordsOf, expandSlashCommand, fillTemplate } from "./commands";
import type { CatalogCommand } from "./types";

describe("command arguments", () => {
  it("groups quoted words", () => {
    expect(commandWordsOf(`one "two words" 'three four' five`)).toEqual(["one", "two words", "three four", "five"]);
  });

  it("gives the remaining words to the highest placeholder", () => {
    expect(fillTemplate("A $1 B $2", "x y z")).toBe("A x B y z");
    expect(fillTemplate("A $1", "x y z")).toBe("A x y z");
  });

  it("fills missing positions with nothing", () => {
    expect(fillTemplate("[$1][$2][$3]", "only")).toBe("[only][][]");
  });

  it("appends arguments only when the template has no placeholder", () => {
    expect(fillTemplate("Do it.", "now please")).toBe("Do it.\n\nnow please");
    expect(fillTemplate("Do it.", "")).toBe("Do it.");
    expect(fillTemplate("Review $ARGUMENTS", "the parser")).toBe("Review the parser");
  });

  it("keeps command overrides on the expanded command", () => {
    const commands: CatalogCommand[] = [{ name: "ship", template: "Ship $1", agent: "build", model: "p/m", subagent: true }];
    expect(expandSlashCommand('/ship "the app"', commands)).toMatchObject({ text: "Ship the app", command: { agent: "build", subagent: true } });
  });
});
