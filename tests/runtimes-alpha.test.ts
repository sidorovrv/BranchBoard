import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "@branchboard/core";
import { configureLogFile, currentLogFile, log, readLogTail } from "../packages/server/src/log";
import { createSeenState, opencodeEventMap, translateEvent } from "../packages/server/src/runtimes/opencode";
import type { RunScope } from "../packages/server/src/run/types";

const SESSION = "ses_main";
const CHILD = "ses_child";
const handle = { sessionId: SESSION };
const scope = {} as RunScope;

const translate = (events: unknown[]) => {
  const seen = createSeenState();
  return events.flatMap((event) => translateEvent(event as never, handle, seen));
};

const mapped = (natives: ReturnType<typeof translate>): RunEvent[] => natives.flatMap((native) => opencodeEventMap[native.type]?.(native, scope) ?? []);

const childCreated = { type: "session.created", properties: { info: { id: CHILD, parentID: SESSION, title: "Look at the logs" } } };
const childText = (text: string) => ({ type: "message.part.delta", properties: { sessionID: CHILD, messageID: "m-child", partID: "p-child", field: "text", delta: text } });
const childPart = { type: "message.part.updated", properties: { part: { id: "p-child", sessionID: CHILD, messageID: "m-child", type: "text", text: "" } } };

describe("OpenCode todos and subagents", () => {
  it("turns todo.updated of the main session into a todo list", () => {
    const events = mapped(translate([{ type: "todo.updated", properties: { sessionID: SESSION, todos: [{ content: "Write", status: "in_progress", priority: "high" }, { content: "Test", status: "pending" }] } }]));
    expect(events).toEqual([{ type: "todos", items: [{ content: "Write", status: "in_progress" }, { content: "Test", status: "pending" }] }]);
  });

  it("ignores todos that belong to another session", () => {
    expect(translate([{ type: "todo.updated", properties: { sessionID: "ses_other", todos: [{ content: "x", status: "pending" }] } }])).toEqual([]);
  });

  it("starts a subagent when a child session appears and routes its text to that subagent", () => {
    const events = mapped(translate([childCreated, childPart, childText("child "), childText("answer")]));
    expect(events[0]).toEqual({ type: "subagent.started", key: CHILD, title: "Look at the logs", agent: undefined });
    const text = events.slice(1).map((event) => (event.type === "subagent.event" && event.event.type === "part.delta" ? event.event.text : ""));
    expect(text.join("")).toBe("child answer");
    expect(events.every((event) => event.type !== "part.delta")).toBe(true);
  });

  it("finishes the subagent when its session goes idle without ending the main run", () => {
    const natives = translate([childCreated, { type: "session.idle", properties: { sessionID: CHILD } }]);
    expect(natives.map((native) => native.type)).toEqual(["subagent-start", "subagent-done"]);
    expect(mapped(natives)[1]).toEqual({ type: "subagent.event", key: CHILD, event: { type: "done" } });
  });

  it("keeps a child's permission request inside the subagent and answerable by its own session", () => {
    const natives = translate([childCreated, { type: "permission.asked", properties: { sessionID: CHILD, id: "perm-1", permission: "bash", patterns: ["npm test"] } }]);
    const request = mapped(natives).find((event) => event.type === "subagent.event" && event.event.type === "request.opened") as Extract<RunEvent, { type: "subagent.event" }>;
    expect(request.event).toMatchObject({ type: "request.opened", request: { kind: "approval", remoteId: `${CHILD}/perm-1`, detail: "npm test" } });
  });

  it("still ends the main run on the main session's idle event", () => {
    expect(translate([childCreated, { type: "session.idle", properties: { sessionID: SESSION } }]).map((native) => native.type)).toEqual(["subagent-start", "idle"]);
  });
});

describe("OpenCode subagent prompts and costs", () => {
  const childUserMessage = { type: "message.updated", properties: { info: { id: "m-user", sessionID: CHILD, role: "user" } } };
  const childUserText = (text: string) => ({ type: "message.part.updated", properties: { part: { id: "p-user", sessionID: CHILD, messageID: "m-user", type: "text", text } } });
  const assistantMessage = (sessionID: string, id: string, cost: number, input: number, output: number) => ({ type: "message.updated", properties: { info: { id, sessionID, role: "assistant", cost, tokens: { input, output, reasoning: 0, cache: { read: 5, write: 1 } } } } });

  it("hands the first message of a child session to its satellite as the prompt", () => {
    const events = mapped(translate([childCreated, childUserMessage, childUserText("Check the logs"), childUserText("Check the logs")]));
    const prompts = events.filter((event) => event.type === "subagent.event" && event.event.type === "prompt");
    expect(prompts).toEqual([{ type: "subagent.event", key: CHILD, event: { type: "prompt", text: "Check the logs" } }]);
  });

  it("takes the agent name from an OpenCode subagent title", () => {
    const events = mapped(translate([{ type: "session.created", properties: { info: { id: CHILD, parentID: SESSION, title: "Find the leak (@explore subagent)" } } }]));
    expect(events[0]).toMatchObject({ type: "subagent.started", agent: "explore" });
  });

  it("reports cumulative tokens and cost across the run and its subagents", () => {
    const seen = createSeenState();
    const run = (event: unknown) => translateEvent(event as never, handle, seen);
    run(childCreated);
    run(assistantMessage(SESSION, "m1", 0.25, 100, 20));
    run(assistantMessage(SESSION, "m1", 0.5, 100, 40));
    const last = run(assistantMessage(CHILD, "m2", 0.125, 10, 2)).at(-1);
    expect(last).toMatchObject({ type: "usage", costUsd: 0.625, inputTokens: 100 + 5 + 1 + 10 + 5 + 1, outputTokens: 42 });
    expect(opencodeEventMap.usage(last!, scope)).toEqual([{ type: "usage", usage: expect.objectContaining({ costUsd: 0.625 }) }]);
  });
});

describe("the server log file", () => {
  const directory = mkdtempSync(join(tmpdir(), "branchboard-log-"));
  const path = join(directory, "logs", "server.log");

  beforeEach(() => configureLogFile(undefined));
  afterAll(() => {
    configureLogFile(undefined);
    rmSync(directory, { recursive: true, force: true });
  });

  it("writes entries, reads the tail and filters by text", () => {
    configureLogFile(path);
    expect(currentLogFile()).toBe(path);
    log.info("test", "first board-aaa line");
    log.info("test", "second board-bbb line\nwith a second line");
    log.info("test", "third board-aaa line");
    expect(readLogTail(10)).toHaveLength(3);
    expect(readLogTail(2)).toHaveLength(2);
    expect(readLogTail(10, "board-aaa")).toHaveLength(2);
    expect(readLogTail(10, "board-bbb")[0]).toContain("with a second line");
  });

  it("rotates the file when it grows past the limit and keeps a few old ones", () => {
    configureLogFile(path);
    const chunk = "x".repeat(1000);
    for (let index = 0; index < 2300; index++) log.info("rotate", `${index} ${chunk}`);
    const files = readdirSync(join(directory, "logs"));
    expect(files).toEqual(expect.arrayContaining(["server.log", "server.log.1"]));
    expect(files.length).toBeLessThanOrEqual(3);
    const tail = readLogTail(5);
    expect(tail.at(-1)).toContain("2299 ");
    expect(existsSync(path)).toBe(true);
  });

  it("returns nothing when no file is configured", () => {
    expect(readLogTail(10)).toEqual([]);
    expect(currentLogFile()).toBeUndefined();
  });
});
