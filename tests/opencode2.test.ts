import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RUNTIMES, type RunEvent } from "@branchboard/core";
import { CUT_OFF_NOTE, STEPS_LIMIT_MESSAGE, STEPS_LIMIT_NOTE } from "../packages/server/src/runtimes/failures";
import { opencodeEventMap } from "../packages/server/src/runtimes/opencode";
import { createSeen2, opencode2Runtime, translateEvent2 } from "../packages/server/src/runtimes/opencode2";
import { locateOpencode2, type LocatorEnvironment } from "../packages/server/src/runtimes/opencodeLocator";
import { majorVersionOf } from "../packages/server/src/runtimes/opencodeGeneration";
import { unsentFileNotes } from "../packages/server/src/run/fileChecks";
import type { RunScope } from "../packages/server/src/run/types";

const ROOT = "ses_root";
const CHILD = "ses_child";
const MESSAGE = "msg_assistant";
const scope = {} as RunScope;

const event = (type: string, data: Record<string, unknown>) => ({ type, data });

const translate = (events: ReturnType<typeof event>[], seen = createSeen2(ROOT)) => events.flatMap((raw) => translateEvent2(raw, seen));

const mapped = (events: ReturnType<typeof event>[]): RunEvent[] => translate(events).flatMap((native) => opencodeEventMap[native.type]?.(native, scope) ?? []);

const base = { sessionID: ROOT, assistantMessageID: MESSAGE };

describe("OpenCode 2 events", () => {
  it("streams text and reasoning as part deltas keyed by message and ordinal", () => {
    expect(
      mapped([
        event("session.reasoning.delta", { ...base, ordinal: 0, delta: "thinking" }),
        event("session.text.delta", { ...base, ordinal: 1, delta: "Hel" }),
        event("session.text.delta", { ...base, ordinal: 1, delta: "lo" }),
      ]),
    ).toEqual([
      { type: "part.delta", partKey: `${MESSAGE}:reasoning:0`, partType: "reasoning", text: "thinking" },
      { type: "part.delta", partKey: `${MESSAGE}:text:1`, partType: "text", text: "Hel" },
      { type: "part.delta", partKey: `${MESSAGE}:text:1`, partType: "text", text: "lo" },
    ]);
  });

  it("sends only the missing tail of a part when it ends", () => {
    const events = mapped([event("session.text.delta", { ...base, ordinal: 0, delta: "Hel" }), event("session.text.ended", { ...base, ordinal: 0, text: "Hello" })]);
    expect(events.map((entry) => (entry as { text: string }).text)).toEqual(["Hel", "lo"]);
    expect(mapped([event("session.text.ended", { ...base, ordinal: 0, text: "Whole" })])).toEqual([{ type: "part.delta", partKey: `${MESSAGE}:text:0`, partType: "text", text: "Whole" }]);
  });

  it("follows a tool call from its name to its result", () => {
    const events = mapped([
      event("session.tool.input.started", { ...base, id: "call_1", name: "write" }),
      event("session.tool.called", { ...base, id: "call_1", input: { path: "a.txt", content: "hi" } }),
      event("session.tool.success", { ...base, id: "call_1", content: [{ type: "text", text: "Created a.txt" }] }),
      event("session.tool.called", { ...base, id: "call_2", input: {} }),
      event("session.tool.failed", { ...base, id: "call_2", error: { type: "tool", message: "No such file" } }),
    ]);
    expect(events).toEqual([
      { type: "tool.started", partKey: "call_1", tool: "write", description: "write", input: { path: "a.txt", content: "hi" } },
      { type: "tool.done", partKey: "call_1", output: "Created a.txt", isError: false },
      { type: "tool.started", partKey: "call_2", tool: "tool", description: "tool", input: {} },
      { type: "tool.done", partKey: "call_2", output: "No such file", isError: true },
    ]);
  });

  it("turns a todowrite call into a todo list", () => {
    const events = mapped([
      event("session.tool.input.started", { ...base, id: "call_1", name: "todowrite" }),
      event("session.tool.called", { ...base, id: "call_1", input: { todos: [{ content: "Write", status: "in_progress" }] } }),
    ]);
    expect(events.map((entry) => entry.type)).toEqual(["tool.started", "todos"]);
  });

  it("opens an approval with the session and request id", () => {
    const events = mapped([event("permission.asked", { id: "per_1", sessionID: ROOT, action: "edit", resources: ["a.txt", "b.txt"] })]);
    expect(events).toEqual([{ type: "request.opened", request: expect.objectContaining({ id: `permission:${ROOT}/per_1`, remoteId: `${ROOT}/per_1`, kind: "approval", title: "edit", detail: "a.txt, b.txt", options: ["once", "always", "reject"] }) }]);
  });

  it("opens a question from a question form and ignores other forms", () => {
    const form = {
      id: "frm_1",
      sessionID: ROOT,
      title: "Questions",
      metadata: { kind: "question" },
      fields: [
        { key: "q0", title: "Color", description: "Which color?", type: "string", options: [{ value: "Red", label: "Red", description: "warm" }, { value: "Blue", label: "Blue" }] },
        { key: "q1", title: "Extras", description: "Which extras?", type: "multiselect", options: [{ value: "a", label: "A" }] },
      ],
    };
    const [opened] = mapped([event("form.created", { form })]);
    expect(opened).toMatchObject({ type: "request.opened", request: { remoteId: `${ROOT}/frm_1/q0,q1`, kind: "question" } });
    const questions = (opened as { request: { questions: unknown[] } }).request.questions;
    expect(questions).toEqual([
      { question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: undefined }], multiple: false, key: "q0" },
      { question: "Which extras?", header: "Extras", options: [{ label: "A", description: undefined }], multiple: true, key: "q1" },
    ]);
    expect(translate([event("form.created", { form: { ...form, fields: [] } })])).toEqual([]);
  });

  it("maps typed fields of other forms and leaves out hidden ones", () => {
    const fields = [
      { key: "name", title: "Name", type: "string", required: true },
      { key: "size", title: "Size", type: "number" },
      { key: "agree", title: "Agree", type: "boolean" },
      { key: "docs", title: "Docs", description: "Open the page", type: "external", url: "https://example.com/auth" },
      { key: "secret", title: "Secret", type: "string", hidden: true },
    ];
    const [other] = translate([event("form.created", { form: { id: "frm_2", sessionID: ROOT, title: "Sign in", metadata: { kind: "auth" }, fields } })]);
    expect(other).toMatchObject({ type: "question", remoteId: `${ROOT}/frm_2/name,size,agree,docs` });
    expect((other as { questions?: unknown }).questions).toEqual([
      expect.not.objectContaining({ optional: true }),
      expect.objectContaining({ header: "Sign in · Size", kind: "number", optional: true }),
      expect.objectContaining({ kind: "boolean", options: [{ label: "Yes" }, { label: "No" }] }),
      expect.objectContaining({ kind: "link", url: "https://example.com/auth", question: "Open the page", options: [{ label: "Done" }] }),
    ]);
  });

  it("ends the run on success or interruption and reports a failure message", () => {
    expect(mapped([event("session.execution.succeeded", { sessionID: ROOT })])).toEqual([{ type: "done" }]);
    expect(mapped([event("session.execution.interrupted", { sessionID: ROOT, reason: "user" })])).toEqual([{ type: "done" }]);
    expect(mapped([event("session.execution.failed", { sessionID: ROOT, error: { type: "provider.no-route", message: "Model unavailable: opencode/x" } })])).toEqual([{ type: "error", message: "Model unavailable: opencode/x", recovery: "setup" }]);
  });

  it("maps authentication and rate limit failures to recovery actions", () => {
    const failed = (error: Record<string, unknown>) => mapped([event("session.execution.failed", { sessionID: ROOT, error })]);
    expect(failed({ type: "provider.auth", status: 401, message: "Incorrect API key" })).toMatchObject([{ recovery: "signIn" }]);
    expect(failed({ type: "provider.rate-limit", status: 429, message: "Slow down" })).toMatchObject([{ recovery: "usageLimit" }]);
    expect(failed({ type: "provider.invalid-request", status: 404, message: "No such model" })).toEqual([{ type: "error", message: "No such model" }]);
  });

  it("reports scheduled provider retries", () => {
    expect(mapped([event("session.retry.scheduled", { sessionID: ROOT, attempt: 2, at: 1700000000000, error: { type: "provider.rate-limit", message: "Rate limited" } })])).toEqual([
      { type: "retry", attempt: 2, at: 1700000000000, reason: "Rate limited" },
    ]);
  });

  it("drops the partial text of a failed step when the engine restarts it", () => {
    const seen = createSeen2(ROOT);
    const events = translate(
      [
        event("session.text.delta", { ...base, ordinal: 0, delta: "Partial" }),
        event("session.step.failed", { ...base, error: { type: "provider.transport" } }),
        event("session.synthetic", { sessionID: ROOT }),
        event("session.text.delta", { sessionID: ROOT, assistantMessageID: "msg_second", ordinal: 0, delta: "Partial" }),
      ],
      seen,
    );
    expect(events.map((entry) => entry.type)).toEqual(["text", "retry-restart", "text"]);
    expect(events[1].partKeys).toEqual([`${MESSAGE}:text:0`]);
  });

  it("adds the cut-off note when a step ends at the length limit", () => {
    expect(mapped([event("session.step.ended", { ...base, finish: "length" })])).toEqual([{ type: "part.delta", partKey: `${MESSAGE}:text:cutoff`, partType: "text", text: CUT_OFF_NOTE }]);
    expect(mapped([event("session.step.ended", { ...base, finish: "stop" })])).toEqual([]);
  });

  it("adds the step limit note once when tools are disabled after the maximum agent steps", () => {
    const failed = (id: string) => event("session.tool.failed", { ...base, id, error: { type: "tool.execution", message: STEPS_LIMIT_MESSAGE } });
    const events = mapped([failed("call_1"), failed("call_2")]);
    expect(events.map((entry) => entry.type)).toEqual(["tool.done", "part.delta", "tool.done"]);
    expect(events[1]).toEqual({ type: "part.delta", partKey: `${MESSAGE}:text:steps`, partType: "text", text: STEPS_LIMIT_NOTE });
  });

  it("adds up usage across the session and its subagents", () => {
    const seen = createSeen2(ROOT);
    translateEvent2(event("session.created", { sessionID: CHILD, parentID: ROOT }), seen);
    const first = translateEvent2(event("session.usage.updated", { sessionID: ROOT, cost: 0.5, tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 20, write: 3 } } }), seen);
    const second = translateEvent2(event("session.usage.updated", { sessionID: CHILD, cost: 0.25, tokens: { input: 50, output: 4, reasoning: 0, cache: { read: 10, write: 0 } } }), seen);
    const third = translateEvent2(event("session.usage.updated", { sessionID: ROOT, cost: 0.75, tokens: { input: 120, output: 12, reasoning: 5, cache: { read: 20, write: 3 } } }), seen);
    expect(first).toEqual([{ type: "usage", inputTokens: 123, outputTokens: 15, cacheReadTokens: 20, cacheCreationTokens: 3, costUsd: 0.5 }]);
    expect(second).toEqual([{ type: "usage", inputTokens: 183, outputTokens: 19, cacheReadTokens: 30, cacheCreationTokens: 3, costUsd: 0.75 }]);
    expect(third).toEqual([{ type: "usage", inputTokens: 203, outputTokens: 21, cacheReadTokens: 30, cacheCreationTokens: 3, costUsd: 1 }]);
  });

  it("draws a subagent from its child session and closes it when the child ends", () => {
    const seen = createSeen2(ROOT);
    const events = [
      event("session.created", { sessionID: CHILD, parentID: ROOT, title: "List files", agent: "explore" }),
      event("session.inbox.enqueued", { sessionID: CHILD, item: { type: "user", payload: { text: "Thoroughness: quick." } } }),
      event("session.text.delta", { sessionID: CHILD, assistantMessageID: "msg_child", ordinal: 0, delta: "Found 3" }),
      event("session.execution.succeeded", { sessionID: CHILD }),
      event("session.text.delta", { ...base, ordinal: 0, delta: "Parent text" }),
    ];
    const out = events.flatMap((raw) => translateEvent2(raw, seen)).flatMap((native) => opencodeEventMap[native.type]?.(native, scope) ?? []);
    expect(out).toEqual([
      { type: "subagent.started", key: CHILD, title: "List files", agent: "explore", prompt: undefined },
      { type: "subagent.event", key: CHILD, event: { type: "prompt", text: "Thoroughness: quick." } },
      { type: "subagent.event", key: CHILD, event: { type: "part.delta", partKey: "msg_child:text:0", partType: "text", text: "Found 3" } },
      { type: "subagent.event", key: CHILD, event: { type: "done" } },
      { type: "part.delta", partKey: `${MESSAGE}:text:0`, partType: "text", text: "Parent text" },
    ]);
  });

  it("ignores events of unrelated sessions and keeps the last assistant message", () => {
    const seen = createSeen2(ROOT);
    expect(translateEvent2(event("session.text.delta", { sessionID: "ses_other", assistantMessageID: "msg_x", ordinal: 0, delta: "no" }), seen)).toEqual([]);
    expect(translateEvent2(event("session.created", { sessionID: "ses_other", parentID: "ses_unrelated" }), seen)).toEqual([]);
    translateEvent2(event("session.text.delta", { ...base, ordinal: 0, delta: "yes" }), seen);
    expect(seen.lastAssistantMessage).toBe(MESSAGE);
  });
});

describe("recorded engine file handling", () => {
  const recordedModel = { id: "cat-jam-free", providerID: "opencode", capabilities: { tools: true, input: ["text"], output: ["text"] } };
  const directory = mkdtempSync(join(tmpdir(), "branchboard-recorded-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const fileOf = (name: string, mime: string, bytes: Buffer) => {
    const path = join(directory, name);
    writeFileSync(path, bytes);
    return { name, mime, path };
  };

  it("names the pdf kind the way the engine does for a model that takes text only", () => {
    const pdf = fileOf("page.pdf", "application/pdf", Buffer.from("%PDF-1.1\n"));
    expect(unsentFileNotes([pdf], recordedModel.capabilities.input)).toEqual(["page.pdf was not sent: the model does not accept pdf files."]);
  });

  it("names every kind the model rejects and keeps text files", () => {
    const files = [
      fileOf("pixel.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      fileOf("page.pdf", "application/pdf", Buffer.from("%PDF-1.1\n")),
      fileOf("note.txt", "text/plain", Buffer.from("plain text\n")),
      fileOf("blob.bin", "application/octet-stream", Buffer.from([0x50, 0x4b, 0, 0xff, 0xfe])),
    ];
    expect(unsentFileNotes(files, ["text", "image"])).toEqual(["page.pdf was not sent: the model does not accept pdf files.", "blob.bin was not sent: it is not UTF-8 text, an image or a PDF."]);
  });
});

describe("OpenCode 2 setup", () => {
  it("is registered with its own command, path variable and install line", () => {
    expect(RUNTIMES.opencode2).toMatchObject({ kind: "cli", pathVariable: "BRANCHBOARD_OPENCODE2_PATH", setup: { install: { linux: "npm install -g @opencode/cli" } } });
    expect(opencode2Runtime.id).toBe("opencode2");
  });

  it("finds opencode2 next to the npm global shim and honours its own override variable", () => {
    const environment = (overrides: Partial<LocatorEnvironment>, files: string[]): LocatorEnvironment => ({ platform: "linux", env: { PATH: "/usr/bin" }, home: "/home/tester", isFile: (path) => files.includes(path), ...overrides });
    const onPath = (name: string) => join("/opt/bin", name);
    expect(locateOpencode2(environment({ env: { PATH: "/opt/bin" } }, [onPath("opencode2")])).path).toBe(onPath("opencode2"));
    expect(locateOpencode2(environment({ env: { PATH: "/opt/bin" } }, [onPath("opencode")])).path).toBeUndefined();
    expect(locateOpencode2(environment({ env: { BRANCHBOARD_OPENCODE2_PATH: "/x/oc2" } }, ["/x/oc2"])).path).toBe("/x/oc2");
    expect(locateOpencode2(environment({ env: { BRANCHBOARD_OPENCODE_PATH: "/x/oc1" } }, ["/x/oc1"])).path).toBeUndefined();
  });
});

describe("OpenCode version detection", () => {
  it("reads the major version from the output of --version", () => {
    expect(majorVersionOf("1.19.0\n")).toBe(1);
    expect(majorVersionOf("opencode 2.0.26")).toBe(2);
    expect(majorVersionOf("not a version")).toBeUndefined();
  });
});
