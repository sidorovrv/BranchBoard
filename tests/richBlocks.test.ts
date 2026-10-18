import { describe, expect, it } from "vitest";
import { resolveRelativePath, parseChartSpec } from "@branchboard/core";

describe("chart fence", () => {
  const bar = { mark: "bar", data: { values: [{ a: 1 }] }, encoding: { x: { field: "a", type: "quantitative" } } };

  it("fills in tooltip, container width and autosize for a single view", () => {
    const parsed = parseChartSpec(JSON.stringify(bar));
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.spec).toMatchObject({ mark: { type: "bar", tooltip: true }, width: "container", autosize: { type: "fit" } });
  });

  it("keeps an explicit width and leaves multi-view specs alone", () => {
    const sized = parseChartSpec(JSON.stringify({ ...bar, width: 300 }));
    if ("error" in sized) throw new Error(sized.error);
    expect(sized.spec.width).toBe(300);
    const concat = parseChartSpec(JSON.stringify({ hconcat: [bar, bar] }));
    if ("error" in concat) throw new Error(concat.error);
    expect(concat.spec).toEqual({ hconcat: [bar, bar] });
  });

  it("refuses data loaded from a URL, at any depth", () => {
    expect(parseChartSpec(JSON.stringify({ ...bar, data: { url: "https://example.com/x.csv" } }))).toMatchObject({ error: expect.stringContaining("inline") });
    expect(parseChartSpec(JSON.stringify({ layer: [{ ...bar, data: { url: "data/x.json" } }] }))).toMatchObject({ error: expect.stringContaining("inline") });
  });

  it("refuses text that is not a JSON object", () => {
    expect(parseChartSpec("[1]")).toMatchObject({ error: expect.any(String) });
    expect(parseChartSpec("mark: bar")).toMatchObject({ error: expect.stringContaining("not valid JSON") });
  });
});

describe("resolveRelativePath", () => {
  it("resolves against the file's folder and stays inside the workspace", () => {
    expect(resolveRelativePath("release/README.md", "../packages/web/public/favicon.svg")).toBe("packages/web/public/favicon.svg");
    expect(resolveRelativePath("README.md", "./img/a%20b.png?raw=1")).toBe("img/a b.png");
    expect(resolveRelativePath("docs/a.md", "/logo.png")).toBe("logo.png");
    expect(resolveRelativePath("a.md", "../outside.png")).toBeUndefined();
  });

  it("refuses remote references", () => {
    expect(resolveRelativePath("a.md", "https://example.com/x.png")).toBeUndefined();
    expect(resolveRelativePath("a.md", "//example.com/x.png")).toBeUndefined();
    expect(resolveRelativePath("a.md", "data:image/png;base64,AAAA")).toBeUndefined();
  });
});
