import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatPart } from "@branchboard/core";
import { ChatView } from "./ChatView";
import { ChatHostContext } from "./host";
import { LiveControls } from "./LiveControls";
import { PromptBlock } from "./PromptBlock";
import { Requests } from "./Requests";

const part = (id: string, type: ChatPart["type"], text: string, meta?: Record<string, unknown>): ChatPart => ({ id, seq: 0, type, text, meta });

const tool = (id: string, name: string, status: string) => part(id, "tool", name, { tool: name, status, input: { file_path: "src/app.ts" } });

const view = (parts: ChatPart[], overrides: Partial<Parameters<typeof ChatView>[0]> = {}) =>
  renderToStaticMarkup(<ChatView parts={parts} isFinished isStreaming={false} isGrouping isFollowing {...overrides} />);

describe("chat view", () => {
  it("renders answer text as markdown", () => {
    expect(view([part("a", "text", "Hello **world**")])).toContain("<strong>world</strong>");
  });

  it("collapses consecutive tool calls into one group when grouping is on", () => {
    const parts = [tool("a", "Read", "ok"), tool("b", "Read", "ok")];
    expect(view(parts)).toContain("tool-group");
    expect(view(parts, { isGrouping: false })).not.toContain("tool-group");
    expect(view(parts, { isGrouping: false }).match(/tool-card/g)).toHaveLength(2);
  });

  it("renders tool output and diff rows only while the card is open", () => {
    const read = part("r", "tool", "Read", { tool: "Read", status: "ok", input: { file_path: "src/app.ts" }, output: "OUTPUT-BODY" });
    const edit = part("e", "tool", "Edit", { tool: "Edit", status: "ok", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } });
    const html = view([read, edit], { isGrouping: false, isFinished: false });
    expect(html).not.toContain("OUTPUT-BODY");
    expect(html).not.toContain("diff-view");
    expect(html).toContain("diff-add");
  });

  it("shows todo progress", () => {
    const todos = part("t", "todo", "", { items: [{ content: "One", status: "completed" }, { content: "Two", status: "pending" }] });
    expect(view([todos])).toContain("1/2");
  });

  it("renders the recovery slot next to an error", () => {
    const html = view([part("e", "error", "Network down")], { renderRecovery: () => <button>Try again</button> });
    expect(html).toContain("Network down");
    expect(html).toContain("Try again");
  });

  it("marks a stopped run and shows the header and footer slots", () => {
    const html = view([], { isStopped: true, header: <i>head</i>, footer: <i>foot</i> });
    expect(html).toContain("stopped");
    expect(html.indexOf("head")).toBeLessThan(html.indexOf("answer"));
    expect(html.indexOf("foot")).toBeGreaterThan(html.indexOf("answer"));
  });

  it("shows the thinking note only for an empty reasoning part of a live run", () => {
    const reasoning = part("r", "reasoning", "");
    expect(view([reasoning], { isFinished: false })).toContain("Thinking");
    expect(view([reasoning])).not.toContain("Thinking");
  });

  it("builds file links through the host", () => {
    const html = renderToStaticMarkup(
      <ChatHostContext.Provider value={{ fileUrl: (path) => `/files?path=${path}` }}>
        <ChatView parts={[part("a", "text", "[report](out/report.html)")]} isFinished isStreaming={false} isGrouping isFollowing />
      </ChatHostContext.Provider>,
    );
    expect(html).toContain('href="/files?path=out/report.html"');
  });

  it("opens file links and file paths through the host opener and leaves other files as plain text", () => {
    const host = { fileUrl: () => undefined, fileOpener: (path: string) => (path === "docs/a.md" ? () => undefined : undefined) };
    const html = renderToStaticMarkup(
      <ChatHostContext.Provider value={host}>
        <ChatView parts={[part("a", "text", "[open](docs/a.md) [skip](docs/b.md) `docs/a.md`")]} isFinished isStreaming={false} isGrouping isFollowing />
      </ChatHostContext.Provider>,
    );
    expect(html).toContain('<a href="#">open</a>');
    expect(html).toContain('<span class="plain-link">skip</span>');
    expect(html).toContain('class="code-link"');
  });

  it("lets renderPart replace a part", () => {
    const html = view([part("a", "text", "plain"), part("b", "text", "custom")], { renderPart: (item) => (item.id === "b" ? <i>replaced</i> : undefined) });
    expect(html).toContain("plain");
    expect(html).toContain("<i>replaced</i>");
    expect(html).not.toContain("custom");
  });
});

describe("prompt block", () => {
  it("collapses by the given line count", () => {
    const render = (collapseLines?: number) => renderToStaticMarkup(<PromptBlock prompt={"a\nb\nc"} isExpanded={false} onExpandedChange={() => undefined} collapseLines={collapseLines} />);
    expect(render()).not.toContain("is-collapsed");
    expect(render(2)).toContain("is-collapsed");
  });
});

describe("requests", () => {
  it("renders approval options and answers with the request id", () => {
    const answers: unknown[][] = [];
    const html = renderToStaticMarkup(<Requests requests={[{ id: "r1", kind: "approval", title: "Run ls", options: ["once", "always", "reject"] }]} onAnswer={(...args) => answers.push(args)} />);
    expect(html).toContain("Allow once");
    expect(html).toContain("Always allow");
    expect(html).toContain("Reason for rejecting");
  });

  it("offers Yes and No for a boolean question without options", () => {
    const questions = [{ question: "Continue?", options: [], kind: "boolean" as const }];
    const html = renderToStaticMarkup(<Requests requests={[{ id: "q1", kind: "question", title: "", options: [], questions }]} onAnswer={() => undefined} />);
    expect(html).toContain(">Yes<");
    expect(html).toContain(">No<");
  });

  it("renders nothing without requests", () => {
    expect(renderToStaticMarkup(<Requests requests={[]} onAnswer={() => undefined} />)).toBe("");
  });
});

describe("live controls", () => {
  it("renders only the offered controls", () => {
    const html = renderToStaticMarkup(<LiveControls controls={["background"]} onFollowUp={() => undefined} onBackground={() => undefined} />);
    expect(html).toContain("Move to background");
    expect(html).not.toContain("Follow-up message");
  });
});
