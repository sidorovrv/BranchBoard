import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingFields, SettingRow, SettingsDialog, type SettingField } from "./Settings";

const noop = () => undefined;

const FIELDS: SettingField[] = [
  { kind: "toggle", key: "follow", label: "Follow", description: "Keep scrolled." },
  { kind: "number", key: "lines", label: "Lines", description: "Collapse after.", min: 2, max: 40, unit: "lines" },
  { kind: "slider", key: "size", label: "Size", description: "Text size.", min: 12, max: 20, step: 1, unit: "px" },
  { kind: "choice", key: "theme", label: "Theme", description: "Colours.", options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }] },
  { kind: "checklist", key: "tags", label: "Tags", description: "Shown tags.", options: [{ value: "cost", label: "Cost" }, { value: "model", label: "Model" }] },
  { kind: "custom", label: "Custom", description: "Own control.", control: <span className="own" /> },
];

const VALUES = { follow: true, lines: 6, size: 14, theme: "dark", tags: ["cost"] };

describe("setting fields", () => {
  it("renders one row per field with the control of its kind", () => {
    const html = renderToStaticMarkup(<SettingFields fields={FIELDS} values={VALUES} onChange={noop} />);
    expect(html.match(/class="setting-row"/g)).toHaveLength(FIELDS.length);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/);
    expect(html).toMatch(/type="number"[^>]*value="6"/);
    expect(html).toMatch(/type="range"[^>]*value="14"/);
    expect(html).toMatch(/aria-checked="true" class="active">Dark/);
    expect(html).toMatch(/checked=""[^>]*\/>Cost/);
    expect(html).toContain('<span class="own">');
  });
});

describe("setting row", () => {
  it("marks a problem description and omits an empty control", () => {
    const html = renderToStaticMarkup(<SettingRow label="Shortcut" description="Taken." isProblem className="shortcut-row" />);
    expect(html).toContain('class="setting-row shortcut-row"');
    expect(html).toContain("setting-description is-problem");
    expect(html).not.toContain("setting-control");
  });
});

describe("settings dialog", () => {
  const sections = [
    { id: "a", label: "Alpha", icon: "tune" as const, summary: "First section." },
    { id: "b", label: "Beta" },
    { id: "v", label: "Version and updates", navText: "Version 1.2.3", isPinnedToBottom: true },
  ];

  it("shows the initial section, its summary, the pinned entry and the reset action", () => {
    const html = renderToStaticMarkup(
      <SettingsDialog title="Settings" closeLabel="Close" sections={sections} initialSectionId="b" reset={{ label: "Reset", title: "Reset all", confirmation: "Sure?", onReset: noop }} onClose={noop}>
        {(section) => <span className="body">{section.id}</span>}
      </SettingsDialog>,
    );
    expect(html).toContain('<h4>Beta</h4>');
    expect(html).toContain('<span class="body">b</span>');
    expect(html).toMatch(/class="settings-pinned"[^>]*>Version 1.2.3/);
    expect(html).toContain("Reset");
    expect(html).not.toContain("First section.");
  });
});
