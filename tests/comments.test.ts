import { describe, expect, it } from "vitest";
import { addNodeEdit, commentClearingEdits, commentsPrompt, commentTargetOf, makeNode, promptWithComment, runEdit, sanitiseNode, seedFrom, shouldAutoRun, type NodeComment, type SeedCommand } from "../packages/core/src";
import { buildGraph, mustApply } from "./support";

const board = { id: "B", title: "t", workspacePath: "", mode: "fake", createdAt: 0, updatedAt: 0, deleted: false } as const;

const comment = (overrides: Partial<NodeComment> = {}): NodeComment => ({ id: "c1", roll: 1, start: 0, end: 5, quote: "alpha", text: "Explain this", ...overrides });

const graphWithAnswer = (overrides = {}) => mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: makeNode("B", { id: "P", status: "done", prompt: "q", rollCount: 2, activeRoll: 2, ...overrides }) });

describe("comments on answers", () => {
  it("adds, updates and removes comments one at a time and undoes with the inverse patch", () => {
    const added = mustApply(graphWithAnswer(), { type: "editComments", nodeId: "P", add: comment({ id: "a", roll: 2 }) });
    const twice = mustApply(added, { type: "editComments", nodeId: "P", add: comment({ id: "b", roll: 2 }) });
    expect(twice.nodes.P.comments?.map((item) => item.id)).toEqual(["a", "b"]);
    const updated = mustApply(twice, { type: "editComments", nodeId: "P", update: { id: "a", text: "Changed" } });
    expect(updated.nodes.P.comments?.[0].text).toBe("Changed");
    const removed = runEdit(updated, { type: "editComments", nodeId: "P", removeId: "a" });
    if ("refusal" in removed) throw new Error(removed.refusal);
    expect(removed.graph.nodes.P.comments?.map((item) => item.id)).toEqual(["b"]);
    expect(removed.inverse.nodes.P.comments).toHaveLength(2);
  });

  it("formats the quote and the comment for the reply prompt", () => {
    expect(commentsPrompt([])).toBe("");
    expect(commentsPrompt([comment({ quote: "line one\nline two", text: "Why?" })])).toBe(`> line one\n> line two\nWhy?\n\n`);
  });

  it("prefills a reply with the comments of the active roll only, does not run it and leaves an explicit prompt alone", () => {
    const graph = graphWithAnswer({ comments: [comment({ id: "old", roll: 1, quote: "old", text: "other roll" }), comment({ id: "now", roll: 2, quote: "now", text: "this roll" })] });
    const command: SeedCommand = { type: "reply", parentIds: ["P"] };
    const seed = seedFrom.reply(graph, command);
    expect(seed.prompt).toContain("> now\nthis roll");
    expect(seed.prompt).not.toContain("other roll");
    expect(shouldAutoRun(seed, command)).toBe(false);
    expect(addNodeEdit(graph, board, seed).node.prompt).toBe(seed.prompt);
    expect(seedFrom.reply(graph, { ...command, prompt: "Hello" }).prompt).toBe("Hello");
  });

  it("clears only the active roll's comments once a prefilled reply is made", () => {
    const graph = graphWithAnswer({ comments: [comment({ id: "old", roll: 1 }), comment({ id: "now", roll: 2 })] });
    const [clearing, ...rest] = commentClearingEdits(graph, { type: "reply", parentIds: ["P"] });
    expect(rest).toEqual([]);
    const cleared = mustApply(graph, clearing);
    expect(cleared.nodes.P.comments?.map((item) => item.id)).toEqual(["old"]);
    expect(commentClearingEdits(graph, { type: "reply", parentIds: ["P"], prompt: "Hello" })).toEqual([]);
    expect(commentClearingEdits(graphWithAnswer(), { type: "reply", parentIds: ["P"] })).toEqual([]);
  });

  it("uses a commented earlier roll once it is selected", () => {
    const graph = graphWithAnswer({ comments: [comment({ roll: 1, quote: "first", text: "keep" })], rolls: { 1: { status: "done" } } });
    const selected = mustApply(graph, { type: "selectRoll", nodeId: "P", roll: 1 });
    expect(seedFrom.reply(selected, { type: "reply", parentIds: ["P"] }).prompt).toContain("> first\nkeep");
  });

  it("drops comments when the history is discarded by a prompt change", () => {
    const graph = graphWithAnswer({ comments: [comment({ roll: 2 })], status: "idle" });
    expect(mustApply(graph, { type: "editNode", nodeId: "P", fields: { prompt: "changed" } }).nodes.P.comments).toEqual([]);
  });

  it("appends a comment to the prompt of the earliest unsent child and has no target once every child has run", () => {
    const withChildren = ["late", "early"].reduce(
      (graph, id, index) => mustApply(graph, { type: "addNode", parentIds: ["P"], node: makeNode("B", { id, status: "idle", prompt: id === "early" ? "draft" : "", createdAt: 10 - index }) }),
      graphWithAnswer(),
    );
    const target = commentTargetOf(withChildren, "P");
    expect(target?.id).toBe("early");
    expect(promptWithComment(target!.prompt, comment())).toBe("draft\n\n> alpha\nExplain this\n\n");
    expect(promptWithComment("", comment())).toBe("> alpha\nExplain this\n\n");
    const finished = mustApply(graphWithAnswer(), { type: "addNode", parentIds: ["P"], node: makeNode("B", { id: "C", status: "done" }) });
    expect(commentTargetOf(finished, "P")).toBeUndefined();
  });

  it("keeps valid comments and drops malformed ones when importing", () => {
    const raw = { ...makeNode("B", { id: "N" }), comments: [comment(), { id: "bad", roll: -1 }] };
    expect(sanitiseNode(raw)?.comments).toEqual([comment()]);
  });
});
