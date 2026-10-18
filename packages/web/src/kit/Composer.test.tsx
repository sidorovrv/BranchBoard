import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChipSelect } from "./ChipSelect";
import { ComposerFrame } from "./ComposerFrame";
import { insertPick, triggerAt } from "./ComposerPicker";

const noop = () => undefined;

describe("composer frame", () => {
  it("places leading chips left and trailing chips, stop and send right", () => {
    const html = renderToStaticMarkup(
      <ComposerFrame editor={<div className="editor" />} leading={<span className="lead" />} trailing={<span className="trail" />} send={{ label: "Send", disabled: true, onClick: noop }} stop={{ label: "Stop", onClick: noop }} />,
    );
    expect(html).toMatch(/composer-chips"><span class="lead">/);
    expect(html).toMatch(/composer-send"><span class="trail"><\/span><button[^>]*aria-label="Stop"/);
    expect(html).toMatch(/aria-label="Send"[^>]*disabled|disabled[^>]*aria-label="Send"/);
  });

  it("omits the stop button without a stop action", () => {
    const html = renderToStaticMarkup(<ComposerFrame editor={null} send={{ label: "Send", disabled: false, onClick: noop }} />);
    expect(html).not.toContain("Stop");
  });

  it("adds the options button beside send and shows the countdown in place of the arrow", () => {
    const html = renderToStaticMarkup(
      <ComposerFrame editor={null} send={{ label: "Send", disabled: false, onClick: noop, countdown: "04:59" }} sendOptions={{ label: "Send options", disabled: false, onClick: noop }} overlay={<div className="popup" />} />,
    );
    expect(html).toMatch(/class="send-button primary send-main countdown"[^>]*>04:59<\/button>/);
    expect(html).toMatch(/aria-label="Send options"/);
    expect(html).toContain('<div class="popup"></div></div>');
  });
});

describe("chip select", () => {
  it("shows the selected label and can be disabled", () => {
    const html = renderToStaticMarkup(<ChipSelect icon="model" title="Model" value="b" options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} disabled onChange={noop} />);
    expect(html).toContain("Beta");
    expect(html).toContain("disabled");
    expect(html).toContain('data-tip="Model"');
  });
});

describe("composer picker", () => {
  it("finds command and mention triggers and inserts the pick", () => {
    expect(triggerAt("/rev", 4)).toEqual({ kind: "command", start: 0, query: "rev" });
    expect(triggerAt("see @src/a", 10)).toEqual({ kind: "mention", start: 4, query: "src/a" });
    expect(triggerAt("plain", 5)).toBeUndefined();
    const trigger = { kind: "mention" as const, start: 4, query: "sr" };
    expect(insertPick("see @sr", 7, trigger, { value: "src/app.ts", label: "src/app.ts" })).toEqual({ text: "see @src/app.ts ", caret: 16 });
  });
});
