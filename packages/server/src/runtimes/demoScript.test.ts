import { describe, expect, it } from "vitest";
import { matchDemoEntry, parseDemoScript } from "./demoScript";

const script = parseDemoScript(
  JSON.stringify({
    "Shortlist markets.": { speed: 2, steps: [{ type: "chunk", text: "hi" }] },
    "Go deeper on this one.": [{ type: "pause", delayMs: 10 }],
    "Summarize.\nUse the wired nodes.\nWrite it down.": { speed: 3, steps: [{ type: "chunk", text: "ok" }] },
  }),
);

describe("demo script", () => {
  it("matches a plain prompt, a branch comment under its quote and a multi-line prompt at the end of a transcript", () => {
    expect(matchDemoEntry(script, "Shortlist  markets.\n")?.speed).toBe(2);
    expect(matchDemoEntry(script, "> 1. Germany: strong\n\nGo deeper on this one.\n\n")?.steps).toHaveLength(1);
    expect(matchDemoEntry(script, "I read the files.\n\n1. Germany\n\nSummarize.\nUse the wired nodes.\nWrite it down.\n")?.speed).toBe(3);
    expect(matchDemoEntry(script, "something else")).toBeUndefined();
  });

  it("rejects unknown step types", () => expect(() => parseDemoScript('{"a":{"steps":[{"type":"nope"}]}}')).toThrow(/unknown type/));
});
