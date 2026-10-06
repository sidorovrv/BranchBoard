import { describe, expect, it } from "vitest";
import {
  addNodeEdit,
  ancestorIds,
  applyPatch,
  asNodeClipboard,
  buildNodeClipboard,
  collectBoard,
  contextHash,
  contextTurns,
  decodeAnswers,
  describeAnswers,
  describeContext,
  encoders,
  encodeAnswers,
  estimateRepublication,
  hasAutoTitle,
  highlightSpans,
  titleForPrompt,
  importBoardDocument,
  isRefusal,
  isStale,
  liveEdges,
  makeNode,
  MAX_UNTRUSTED_NODES,
  NODE_GAP,
  NODE_MAX_HEIGHT,
  NODE_MAX_WIDTH,
  NODE_MIN_HEIGHT,
  NODE_MIN_WIDTH,
  NODE_ROW_GAP,
  NOTE_HEIGHT,
  NOTE_MIN_HEIGHT,
  NOTE_MIN_WIDTH,
  NOTE_WIDTH,
  orderedAncestorIds,
  planSession,
  renderInput,
  runEdit,
  seedFrom,
  type BoardGraph,
  type GraphEdit,
  parseQuestionSpec,
  preferredPermissionMode,
  RUNTIME_DEFAULT_PERMISSION_MODE,
  describeSensitiveFiles,
  isSensitivePath,
  sensitivePathsOf,
} from "@branchboard/core";
import { BOARD, buildGraph, finishedParts, mustApply, randomDag, seededRandom, withNode } from "./support";

const diamond = () =>
  buildGraph(["A", "B", "C", "D", "E", "F"], [["A", "B"], ["A", "E"], ["B", "C"], ["B", "D"], ["C", "F"], ["D", "F"]]);

describe("context rule", () => {
  const cases: [string, string[]][] = [
    ["A", []],
    ["B", ["A"]],
    ["E", ["A"]],
    ["D", ["A", "B"]],
    ["F", ["A", "B", "C", "D"]],
  ];
  it.each(cases)("ancestors of %s", (id, expected) => {
    expect([...ancestorIds(diamond(), id)].sort()).toEqual(expected);
  });

  it("orders ancestors topologically, once each, ties by edge order", () => {
    expect(orderedAncestorIds(diamond(), "F")).toEqual(["A", "B", "C", "D"]);
  });

  it("disconnecting an edge removes only what that edge brought", () => {
    let graph = withNode(diamond(), "N");
    graph = mustApply(graph, { type: "connect", fromId: "N", toId: "D" });
    expect(orderedAncestorIds(graph, "F")).toContain("N");
    const edge = liveEdges(graph).find((candidate) => candidate.fromId === "N")!;
    graph = mustApply(graph, { type: "disconnect", edgeId: edge.id });
    expect(orderedAncestorIds(graph, "F")).toEqual(["A", "B", "C", "D"]);
    expect(orderedAncestorIds(graph, "D")).toEqual(["A", "B"]);
  });

  it("reordering parents changes the context order", () => {
    const graph = buildGraph(["A", "B", "C"], [["A", "C"], ["B", "C"]]);
    const [first, second] = liveEdges(graph).sort((left, right) => left.seq - right.seq);
    const reordered = mustApply(graph, { type: "reorderParents", nodeId: "C", edgeIds: [second.id, first.id] });
    expect(orderedAncestorIds(graph, "C")).toEqual(["A", "B"]);
    expect(orderedAncestorIds(reordered, "C")).toEqual(["B", "A"]);
  });
});

describe("edge refusals", () => {
  const graph = buildGraph(["A", "B", "C"], [["A", "B"], ["B", "C"]]);
  const note = withNode(graph, "N", [], { kind: "context" });
  const cases: [string, BoardGraph, GraphEdit, RegExp][] = [
    ["cycle", graph, { type: "connect", fromId: "C", toId: "A" }, /cycle/],
    ["self edge", graph, { type: "connect", fromId: "A", toId: "A" }, /itself/],
    ["duplicate", graph, { type: "connect", fromId: "A", toId: "B" }, /already/],
    ["note target", note, { type: "connect", fromId: "A", toId: "N" }, /note/],
    ["missing node", graph, { type: "connect", fromId: "A", toId: "ghost" }, /no longer/],
  ];
  it.each(cases)("%s is refused", (_name, subject, edit, reason) => {
    const result = runEdit(subject, edit);
    expect(isRefusal(result) && result.refusal).toMatch(reason);
  });

  it("reattach refuses a cycle but allows a legal move", () => {
    const base = buildGraph(["A", "B", "C", "D"], [["A", "B"], ["B", "C"]]);
    const edge = liveEdges(base).find((candidate) => candidate.fromId === "A")!;
    expect(isRefusal(runEdit(base, { type: "reattach", edgeId: edge.id, end: "from", nodeId: "C" }))).toBe(true);
    expect(isRefusal(runEdit(base, { type: "reattach", edgeId: edge.id, end: "from", nodeId: "D" }))).toBe(false);
  });
});

describe("property tests on random DAGs", () => {
  const random = seededRandom(7);
  const dags = Array.from({ length: 25 }, () => randomDag(random, 12));

  it("context has exactly the ancestors, once, parents before children", () => {
    for (const { graph, ids } of dags) {
      for (const id of ids) {
        const ordered = orderedAncestorIds(graph, id);
        expect(new Set(ordered).size).toBe(ordered.length);
        expect([...ordered].sort()).toEqual([...ancestorIds(graph, id)].sort());
        ordered.forEach((ancestor, index) => {
          const earlier = new Set(ordered.slice(0, index));
          for (const upstream of ancestorIds(graph, ancestor)) expect(earlier.has(upstream)).toBe(true);
        });
      }
    }
  });

  it("no connect ever produces a cycle", () => {
    for (const { graph, ids } of dags) for (const id of ids) expect(ancestorIds(graph, id).has(id)).toBe(false);
  });

  it("apply then invert restores every edit kind", () => {
    for (const { graph, ids } of dags) {
      const edge = liveEdges(graph)[0];
      const edits: GraphEdit[] = [
        { type: "deleteNodes", ids: [ids[0]], withExclusiveDescendants: true },
        { type: "moveNodes", positions: { [ids[1]]: { x: 5, y: 9 } } },
        { type: "collapse", nodeId: ids[2] },
        { type: "editNode", nodeId: ids[3], fields: { title: "renamed", prompt: "changed" } },
        { type: "connect", fromId: ids[4], toId: ids[5] },
        ...(edge ? ([{ type: "disconnect", edgeId: edge.id }] as GraphEdit[]) : []),
      ];
      for (const edit of edits) {
        const result = runEdit(graph, edit);
        if (isRefusal(result)) continue;
        const restored = applyPatch(result.graph, result.inverse);
        for (const id of ids) expect(restored.nodes[id]).toEqual(graph.nodes[id]);
        const liveBefore = liveEdges(graph).map((candidate) => candidate.id).sort();
        expect(liveEdges(restored).map((candidate) => candidate.id).sort()).toEqual(liveBefore);
      }
    }
  });

  it("deleting a node never leaves live edges touching it", () => {
    for (const { graph, ids } of dags) {
      const result = runEdit(graph, { type: "deleteNodes", ids: [ids[0]] });
      if (isRefusal(result)) continue;
      expect(liveEdges(result.graph).every((edge) => edge.fromId !== ids[0] && edge.toId !== ids[0])).toBe(true);
    }
  });
});

describe("run locks", () => {
  const running = (graph: BoardGraph, id: string): BoardGraph => applyPatch(graph, { nodes: { [id]: { id, status: "running" } }, edges: {} });

  it("blocks edits, deletes and relinks on a running node and everything upstream", () => {
    const graph = running(buildGraph(["A", "B", "C", "X"], [["A", "B"], ["B", "C"]]), "C");
    const edgeIntoB = liveEdges(graph).find((edge) => edge.toId === "B")!;
    expect(isRefusal(runEdit(graph, { type: "deleteNodes", ids: ["A"] }))).toBe(true);
    expect(isRefusal(runEdit(graph, { type: "deleteNodes", ids: ["C"] }))).toBe(true);
    expect(isRefusal(runEdit(graph, { type: "disconnect", edgeId: edgeIntoB.id }))).toBe(true);
    expect(isRefusal(runEdit(graph, { type: "connect", fromId: "X", toId: "C" }))).toBe(true);
    expect(isRefusal(runEdit(graph, { type: "editNode", nodeId: "A", fields: { prompt: "changed" } }))).toBe(true);
  });

  it("still allows branching off blocked nodes and touching unrelated nodes", () => {
    const graph = running(buildGraph(["A", "B", "X"], [["A", "B"]]), "B");
    expect(isRefusal(runEdit(graph, { type: "deleteNodes", ids: ["X"] }))).toBe(false);
    expect(isRefusal(runEdit(graph, { type: "connect", fromId: "B", toId: "X" }))).toBe(false);
    const branch = makeNode(BOARD, { id: "child" });
    expect(isRefusal(runEdit(graph, { type: "addNode", node: branch, parentIds: ["A"] }))).toBe(false);
  });

  it("reopen and queue only apply to finished or idle chats", () => {
    const graph = buildGraph(["A"], []);
    expect(isRefusal(runEdit(graph, { type: "reopen", nodeId: "A" }))).toBe(true);
    expect(isRefusal(runEdit(graph, { type: "queue", nodeId: "A" }))).toBe(false);
  });
});

describe("republication estimate", () => {
  it("reports the context a new link would force the node to re-send", () => {
    const graph = buildGraph(["A", "B", "C"], [["A", "C"]]);
    const estimate = estimateRepublication(graph, { A: finishedParts("A", "answer A"), B: finishedParts("B", "answer B") }, { type: "connect", fromId: "B", toId: "C" });
    expect(estimate).toHaveLength(1);
    expect(estimate[0].tokens).toBeGreaterThan(0);
  });
});

describe("staleness and session plan", () => {
  const finish = (graph: BoardGraph, id: string): BoardGraph =>
    applyPatch(graph, {
      nodes: {
        [id]: {
          ...graph.nodes[id],
          status: "done",
          contextHash: contextHash(graph, id),
          contextNodeIds: orderedAncestorIds(graph, id),
          runtimeRef: { sessionId: `session-${id}`, lastMessageId: `msg-${id}` },
        },
      },
      edges: {},
    });
  const parts = { A: finishedParts("A", "answer A"), B: finishedParts("B", "answer B") };

  it("rewiring marks a finished node stale", () => {
    let graph = buildGraph(["A", "B", "C"], [["A", "C"], ["B", "C"]]);
    graph = finish(graph, "C");
    expect(isStale(graph, graph.nodes.C)).toBe(false);
    const edge = liveEdges(graph).find((candidate) => candidate.fromId === "B")!;
    graph = mustApply(graph, { type: "disconnect", edgeId: edge.id });
    expect(isStale(graph, graph.nodes.C)).toBe(true);
  });

  it("editing a note makes descendants stale", () => {
    let graph = withNode(buildGraph([], []), "N", [], { kind: "context" });
    graph = withNode(graph, "C", ["N"]);
    graph = finish(graph, "C");
    graph = mustApply(graph, { type: "editNode", nodeId: "N", fields: { prompt: "new text" } });
    expect(isStale(graph, graph.nodes.C)).toBe(true);
  });

  it("one finished parent whose session already holds everything is exact", () => {
    const graph = finish(buildGraph(["A", "C"], [["A", "C"]]), "A");
    const plan = planSession(graph, parts, "C");
    expect(plan.spine?.nodeId).toBe("A");
    expect(describeContext(graph, parts, "C").mode).toBe("exact");
  });

  it("no valid parent session assembles the whole context", () => {
    const graph = buildGraph(["A", "C"], [["A", "C"]]);
    const plan = planSession(graph, parts, "C");
    expect(plan.spine).toBeUndefined();
    expect(plan.missingTurns).toHaveLength(1);
    expect(describeContext(graph, parts, "C").mode).toBe("assembled");
  });

  it("an extra parent is injected into the spine's session", () => {
    const graph = finish(buildGraph(["A", "B", "C"], [["A", "C"], ["B", "C"]]), "A");
    const plan = planSession(graph, parts, "C");
    expect(plan.spine?.nodeId).toBe("A");
    expect(plan.missingTurns.map((turn) => turn.nodeId)).toEqual(["B"]);
    expect(describeContext(graph, parts, "C").mode).toBe("injected");
  });

  it("a stale parent session is not reused", () => {
    let graph = buildGraph(["A", "B", "C"], [["A", "B"], ["B", "C"]]);
    graph = finish(graph, "B");
    graph = mustApply(graph, { type: "editNode", nodeId: "A", fields: { prompt: "changed" } });
    expect(planSession(graph, parts, "C").spine).toBeUndefined();
  });

  it("forceAssemble skips the spine", () => {
    let graph = finish(buildGraph(["A", "C"], [["A", "C"]]), "A");
    graph = mustApply(graph, { type: "editNode", nodeId: "C", fields: { forceAssemble: true } });
    expect(planSession(graph, parts, "C").spine).toBeUndefined();
  });

  it("renderInput puts the missing turns before the prompt", () => {
    const graph = buildGraph(["A", "C"], [["A", "C"]]);
    const text = renderInput(planSession(graph, parts, "C"), "the question");
    expect(text).toContain("answer A");
    expect(text.endsWith("the question")).toBe(true);
    expect(contextTurns(graph, parts, "C")).toHaveLength(1);
  });

  it("renderInput quotes the selected passage ahead of the prompt", () => {
    const graph = buildGraph(["A", "C"], [["A", "C"]]);
    const text = renderInput(planSession(graph, parts, "C"), "why?", "line one\nline two");
    expect(text.endsWith("> line one\n> line two\n\nwhy?")).toBe(true);
  });
});

describe("files that may hold secrets", () => {
  it("flags environment files, keys, certificates and the git folder", () => {
    const flagged = [".env", ".env.local", "app/.ENV.production", "keys/server.pem", "tls\\site.key", "id_rsa", "a/id_ed25519", "certs/ca.crt", "store.p12", ".git/config", "sub/.git/HEAD"];
    flagged.forEach((path) => expect(isSensitivePath(path), path).toBe(true));
  });

  it("leaves ordinary files alone", () => {
    const fine = ["notes.md", "environment.ts", "src/env.ts", ".gitignore", ".github/workflows/ci.yml", "id_rsa.pub", ".env.example", "config/.env.sample", ".env.local.template", "keyboard.ts", "monkey.txt", "src/environment/.envrc.md"];
    fine.forEach((path) => expect(isSensitivePath(path), path).toBe(false));
  });

  it("lists each flagged path once", () => {
    expect(sensitivePathsOf([".env", "a.txt", ".env"])).toEqual([".env"]);
  });

  it("describes the files in the question the user is asked", () => {
    expect(describeSensitiveFiles([".env", "k.pem"])).toContain("• .env\n• k.pem");
  });
});

describe("default permission mode", () => {
  const modes = [{ id: "manual" }, { id: "acceptEdits" }, { id: "auto" }];

  it("uses the chosen mode only when the runtime offers it", () => {
    expect(preferredPermissionMode(modes, "manual")).toBe("manual");
    expect(preferredPermissionMode(modes, "bypassPermissions")).toBeUndefined();
    expect(preferredPermissionMode(undefined, "manual")).toBeUndefined();
  });

  it("leaves the runtime's own default when nothing is chosen", () => {
    expect(preferredPermissionMode(modes, RUNTIME_DEFAULT_PERMISSION_MODE)).toBeUndefined();
  });
});

describe("export and import", () => {
  it("round-trips nodes, edges and parts with new identities", () => {
    const graph = buildGraph(["A", "B", "C"], [["A", "C"], ["B", "C"]]);
    const parts = { A: finishedParts("A", "alpha"), B: finishedParts("B", "beta") };
    const board = { id: BOARD, title: "t", workspacePath: ".", mode: "fake" as const, createdAt: 1, updatedAt: 1, deleted: false };
    const imported = importBoardDocument(encoders.json(collectBoard({ board, graph, parts })));
    const importedNodes = Object.values(imported.graph.nodes);
    expect(importedNodes).toHaveLength(3);
    expect(importedNodes.every((node) => node.boardId === imported.boardId && !["A", "B", "C"].includes(node.id))).toBe(true);
    expect(liveEdges(imported.graph)).toHaveLength(2);
    const importedParts = Object.values(imported.parts).flat();
    expect(importedParts.map((part) => part.text).sort()).toEqual(["alpha", "beta"]);
    expect(importedParts.every((part) => part.id.startsWith(part.nodeId))).toBe(true);
  });

  it("still imports documents exported under the previous product name", () => {
    const graph = buildGraph(["A", "B"], [["A", "B"]]);
    const board = { id: BOARD, title: "t", workspacePath: ".", mode: "fake" as const, createdAt: 1, updatedAt: 1, deleted: false };
    const exported = JSON.parse(encoders.json(collectBoard({ board, graph, parts: {} })));
    expect(exported.format).toBe("branchboard");
    const legacyDocument = JSON.stringify({ ...exported, format: "wanderboard" });
    expect(Object.values(importBoardDocument(legacyDocument).graph.nodes)).toHaveLength(2);
  });

  it("rejects foreign documents", () => {
    expect(() => importBoardDocument("{}")).toThrow();
  });

  describe("untrusted documents", () => {
    const board = { id: BOARD, title: "t", workspacePath: ".", mode: "fake" as const, createdAt: 1, updatedAt: 1, deleted: false };
    const exportedDocument = () => JSON.parse(encoders.json(collectBoard({ board, graph: buildGraph(["A", "B"], [["A", "B"]]), parts: { A: finishedParts("A", "alpha") } })));
    const importEdited = (edit: (document: any) => void) => {
      const document = exportedDocument();
      edit(document);
      return importBoardDocument(JSON.stringify(document));
    };

    it("drops the agent and permission mode a file asks for", () => {
      const imported = importEdited((document) => Object.assign(document.nodes[0], { agent: "build", permissionMode: "dontAsk", model: "sonnet" }));
      const node = Object.values(imported.graph.nodes).find((candidate) => candidate.prompt === "prompt A")!;
      expect(node.permissionMode).toBeUndefined();
      expect(node.agent).toBeUndefined();
      expect(node.model).toBe("sonnet");
    });

    it("drops a model name that could carry arguments", () => {
      const imported = importEdited((document) => (document.nodes[0].model = "sonnet --dangerously-skip-permissions"));
      expect(Object.values(imported.graph.nodes).every((node) => node.model === undefined)).toBe(true);
    });

    it("rejects connections that form a loop", () => {
      expect(() => importEdited((document) => document.edges.push({ ...document.edges[0], fromId: document.edges[0].toId, toId: document.edges[0].fromId }))).toThrow(/loop/);
    });

    it("rejects duplicate node ids, malformed nodes and oversized files", () => {
      expect(() => importEdited((document) => (document.nodes[1].id = document.nodes[0].id))).toThrow(/share one id/);
      expect(() => importEdited((document) => (document.nodes[0].prompt = 42))).toThrow(/malformed/);
      expect(() => importEdited((document) => (document.nodes = Array.from({ length: MAX_UNTRUSTED_NODES + 1 }, () => document.nodes[0])))).toThrow(/Too many/);
    });

    it("ignores edges to unknown nodes and clamps geometry", () => {
      const imported = importEdited((document) => {
        document.edges.push({ ...document.edges[0], toId: "missing" });
        Object.assign(document.nodes[0], { x: 1e300, w: -5, h: 1e9 });
      });
      expect(liveEdges(imported.graph)).toHaveLength(1);
      const node = Object.values(imported.graph.nodes).find((candidate) => candidate.prompt === "prompt A")!;
      expect(node.x).toBeLessThanOrEqual(10_000_000);
      expect(node.w).toBeGreaterThan(0);
      expect(node.h).toBeLessThanOrEqual(NODE_MAX_HEIGHT);
    });

    it("keeps nothing from the file's board except its title", () => {
      const imported = importEdited((document) => Object.assign(document.board, { workspacePath: "C:\\", title: "shared", budgetTokens: 1 }));
      expect(Object.keys(imported).sort()).toEqual(["boardId", "graph", "parts", "title"]);
      expect(imported.title).toBe("shared (imported)");
    });

    it("applies the same checks to pasted nodes", () => {
      const clipboard = buildNodeClipboard(buildGraph(["A"], []), {}, ["A"])!;
      const tampered = { ...clipboard, nodes: [{ ...clipboard.nodes[0], permissionMode: "dontAsk", agent: "build" }] };
      const accepted = asNodeClipboard(JSON.parse(JSON.stringify(tampered)))!;
      expect(accepted.nodes[0].permissionMode).toBeUndefined();
      expect(accepted.nodes[0].agent).toBeUndefined();
      expect(asNodeClipboard({ ...tampered, nodes: [{ ...clipboard.nodes[0], status: "bogus" }] })).toBeUndefined();
    });
  });
});

describe("question answers", () => {
  it("parses question specs from both runtimes' shapes", () => {
    expect(parseQuestionSpec({ question: "Pick", header: "H", options: [{ label: "a", description: "d" }, "b"], multiSelect: true })).toEqual({
      question: "Pick",
      header: "H",
      options: [{ label: "a", description: "d" }, { label: "b", description: undefined }],
      multiple: true,
    });
    expect(parseQuestionSpec({ question: "Solo", options: [] }).multiple).toBe(false);
  });

  it("round-trips an answer grid", () => {
    const grid = [["apple"], ["cream", "nuts"]];
    expect(decodeAnswers(2, encodeAnswers(grid))).toEqual(grid);
  });

  it("wraps a plain text answer as the first answer", () => {
    expect(decodeAnswers(2, "just text")).toEqual([["just text"], []]);
    expect(decodeAnswers(1, "42")).toEqual([["42"]]);
  });

  it("describes answers for display", () => {
    expect(describeAnswers(2, encodeAnswers([["apple"], ["cream", "nuts"]]))).toBe("apple | cream, nuts");
  });
});

describe("run choices", () => {
  const board = { id: BOARD, title: "t", workspacePath: "", mode: "fake", defaultEffort: "low", defaultPermissionMode: "plan", createdAt: 0, updatedAt: 0, deleted: false } as const;
  const parent = makeNode(BOARD, { id: "P", model: "m", effort: "high", permissionMode: "acceptEdits" });
  const graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: parent });

  it("lets a reply inherit effort and permission mode from its first parent", () => {
    const node = addNodeEdit(graph, board, seedFrom.reply(graph, { type: "reply", parentIds: ["P"] })).node;
    expect([node.model, node.effort, node.permissionMode]).toEqual(["m", "high", "acceptEdits"]);
  });

  it("prefers explicit choices, then falls back to the board defaults for a new root", () => {
    const explicit = addNodeEdit(graph, board, seedFrom.reply(graph, { type: "reply", parentIds: ["P"], effort: "max" })).node;
    expect(explicit.effort).toBe("max");
    const root = addNodeEdit(graph, board, seedFrom.reply(graph, { type: "reply" })).node;
    expect([root.effort, root.permissionMode]).toEqual(["low", "plan"]);
  });

  it("refuses a change of effort on a finished node", () => {
    const finished = mustApply(graph, { type: "patch", patch: { nodes: { P: { id: "P", status: "done" } }, edges: {} } });
    expect(isRefusal(runEdit(finished, { type: "editNode", nodeId: "P", fields: { effort: "low" } }))).toBe(true);
  });
});

describe("horizontal layout", () => {
  const board = { id: BOARD, title: "t", workspacePath: "", mode: "fake", createdAt: 0, updatedAt: 0, deleted: false } as const;
  const addReply = (graph: BoardGraph, parentId: string) => {
    const edit = addNodeEdit(graph, board, seedFrom.reply(graph, { type: "reply", parentIds: [parentId] }));
    return { graph: mustApply(graph, edit), node: edit.node };
  };

  it("puts the first child to the right of its parent at the parent's top and width", () => {
    const parent = makeNode(BOARD, { id: "P", x: 100, y: 50, w: 600 });
    const graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: parent });
    const { node } = addReply(graph, "P");
    expect([node.x, node.y, node.w]).toEqual([100 + 600 + NODE_GAP, 50, 600]);
  });

  it("stacks further children below the previous one in the same column", () => {
    const parent = makeNode(BOARD, { id: "P", x: 0, y: 0 });
    const first = addReply(mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: parent }), "P");
    const second = addReply(first.graph, "P");
    expect(second.node.x).toBe(first.node.x);
    expect(second.node.y).toBe(first.node.y + first.node.h + NODE_ROW_GAP);
  });

  it("gives a branch a thread-prefixed placeholder title straight away", () => {
    const parent = makeNode(BOARD, { id: "P", title: "Thread name" });
    const first = addReply(mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: parent }), "P");
    const plain = seedFrom.reply(first.graph, { type: "reply", parentIds: ["P"], prompt: "second question" });
    const branch = addNodeEdit(first.graph, board, plain).node;
    expect(branch.title).toBe("Thread name › second question");
    expect(addNodeEdit(buildGraph([], []), board, { kind: "turn", parentIds: [], prompt: "root" }).node.title).toBe("root");
  });

  it("clamps a requested root width", () => {
    const wide = addNodeEdit(buildGraph([], []), board, seedFrom.reply(buildGraph([], []), { type: "reply", width: 99999 }));
    expect(wide.node.w).toBe(NODE_MAX_WIDTH);
  });

  it("makes notes small and lets them shrink to a quarter of the chat minimum", () => {
    const note = addNodeEdit(buildGraph([], []), board, seedFrom.note(buildGraph([], []), { type: "note", width: 900 })).node;
    expect([note.w, note.h]).toEqual([NOTE_WIDTH, NOTE_HEIGHT]);
    expect([NOTE_MIN_WIDTH, NOTE_MIN_HEIGHT]).toEqual([NODE_MIN_WIDTH / 4, NODE_MIN_HEIGHT / 4]);
  });

  it("keeps a branch's title automatic after its prompt is typed", () => {
    const branch = makeNode(BOARD, { id: "B", title: "Thread › New chat", prompt: "typed later" });
    expect(hasAutoTitle(branch)).toBe(true);
    expect(titleForPrompt(branch, "typed later")).toBe("Thread › typed later");
    expect(titleForPrompt(makeNode(BOARD, { title: "New chat" }), "plain")).toBe("plain");
  });

  it("propagates a rename to branches and plain replies that carry the old name, in one undoable edit", () => {
    let graph = buildGraph(["R", "B", "P"], [["R", "B"], ["R", "P"]]);
    graph = mustApply(graph, { type: "editNode", nodeId: "R", fields: { title: "Old" } });
    graph = mustApply(graph, { type: "editNode", nodeId: "B", fields: { title: "Old › branch" } });
    graph = mustApply(graph, { type: "editNode", nodeId: "P", fields: { title: "Old" } });
    const result = runEdit(graph, { type: "editNode", nodeId: "R", fields: { title: "Fresh" } });
    if (isRefusal(result)) throw new Error(result.refusal);
    expect([result.graph.nodes.B.title, result.graph.nodes.P.title]).toEqual(["Fresh › branch", "Fresh"]);
    const undone = runEdit(result.graph, { type: "patch", patch: result.inverse });
    if (isRefusal(undone)) throw new Error(undone.refusal);
    expect([undone.graph.nodes.R.title, undone.graph.nodes.B.title, undone.graph.nodes.P.title]).toEqual(["Old", "Old › branch", "Old"]);
  });

  it("lets a plain reply inherit its parent's title", () => {
    const parent = makeNode(BOARD, { id: "P", title: "Thread name" });
    const graph = mustApply(buildGraph([], []), { type: "addNode", parentIds: [], node: parent });
    expect(addNodeEdit(graph, board, seedFrom.reply(graph, { type: "reply", parentIds: ["P"], prompt: "next" })).node.title).toBe("Thread name");
  });
});

describe("highlightSpans", () => {
  it("marks inline code and fenced blocks without losing characters", () => {
    const text = "use `foo` now\n```ts\nconst a = `b`;\n```\nafter";
    const spans = highlightSpans(text);
    expect(spans.map((span) => span.text).join("")).toBe(text);
    expect(spans.filter((span) => span.kind === "inline-code").map((span) => span.text)).toEqual(["`foo`"]);
    expect(spans.filter((span) => span.kind === "fence-line").map((span) => span.text)).toEqual(["```ts", "```"]);
    expect(spans.filter((span) => span.kind === "block-code").map((span) => span.text)).toEqual(["const a = `b`;"]);
  });

  it("keeps an unclosed fence highlighted while typing", () => {
    const spans = highlightSpans("```\nlong one");
    expect(spans.filter((span) => span.kind === "fence-line" || span.kind === "block-code")).toHaveLength(2);
  });
});
