import { describe, expect, it } from "vitest";
import { csvFileName, resolveRelativePath, linkTargetOf, matchingRowIndexes, nextSort, parseChartSpec, parseNumber, parseTableSpec, sortedRowIndexes, tableFromText, tableToDelimited, visibleRowIndexes } from "@branchboard/core";

const fruit = tableFromText(
  ["Name", "Price", "Added"],
  [
    ["Pear", "$1,200.50", "2026-03-01"],
    ["apple", "9", "2025-12-31"],
    ["Fig", "", "2026-01-15"],
    ["Plum", "-3.5", "2026-02-01"],
  ],
);

describe("table model", () => {
  it("detects number, date and text columns", () => {
    expect(fruit.columns.map((column) => column.type)).toEqual(["text", "number", "date"]);
  });

  it("parses formatted numbers", () => {
    expect(parseNumber("$1,200.50")).toBe(1200.5);
    expect(parseNumber("12%")).toBe(12);
    expect(parseNumber("\u22123")).toBe(-3);
    expect(parseNumber("1,20")).toBeUndefined();
    expect(parseNumber("abc")).toBeUndefined();
  });

  it("sorts numbers by value with blanks last in both directions", () => {
    expect(sortedRowIndexes(fruit, 1, "asc")).toEqual([3, 1, 0, 2]);
    expect(sortedRowIndexes(fruit, 1, "desc")).toEqual([0, 1, 3, 2]);
  });

  it("sorts text without regard to case and dates by time", () => {
    expect(sortedRowIndexes(fruit, 0, "asc")).toEqual([1, 2, 0, 3]);
    expect(sortedRowIndexes(fruit, 2, "asc")).toEqual([1, 2, 3, 0]);
  });

  it("cycles ascending, descending, off", () => {
    const first = nextSort(undefined, 1);
    expect(first).toEqual({ column: 1, direction: "asc" });
    const second = nextSort(first, 1);
    expect(second).toEqual({ column: 1, direction: "desc" });
    expect(nextSort(second, 1)).toBeUndefined();
    expect(nextSort(second, 0)).toEqual({ column: 0, direction: "asc" });
  });

  it("filters on every term in any column", () => {
    expect(matchingRowIndexes(fruit, "pear 2026")).toEqual([0]);
    expect(matchingRowIndexes(fruit, "")).toEqual([0, 1, 2, 3]);
    expect(visibleRowIndexes(fruit, "202", { column: 1, direction: "asc" })).toEqual([3, 1, 0, 2]);
    expect(visibleRowIndexes(fruit, "2026", { column: 1, direction: "asc" })).toEqual([3, 0, 2]);
  });

  it("exports the visible rows as TSV and quoted CSV", () => {
    expect(tableToDelimited(fruit, [1], "\t")).toBe("Name\tPrice\tAdded\napple\t9\t2025-12-31");
    const quoted = tableFromText(["a", "b"], [['say "hi", ok', "line\nbreak"]]);
    expect(tableToDelimited(quoted, [0], ",")).toBe('a,b\n"say ""hi"", ok",line break');
  });
});

describe("table fence", () => {
  it("builds a table from object rows with formatted cells and an initial sort", () => {
    const parsed = parseTableSpec(
      JSON.stringify({
        title: "Sales",
        columns: [{ key: "name", label: "Name" }, { key: "total", label: "Total", type: "currency", currency: "USD", digits: 0 }, { key: "share", type: "percent" }],
        rows: [{ name: "A", total: 1500, share: 0.25 }, { name: "B", total: 20, share: 0.5 }],
        sort: { column: "total", direction: "desc" },
      }),
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.table.title).toBe("Sales");
    expect(parsed.table.columns.map((column) => column.label)).toEqual(["Name", "Total", "share"]);
    expect(parsed.table.rows[0].cells[2]).toBe("25%");
    expect(parsed.table.rows[0].sortValues[1]).toBe(1500);
    expect(parsed.table.initialSort).toEqual({ column: 1, direction: "desc" });
  });

  it("accepts array rows and plain string columns", () => {
    const parsed = parseTableSpec('{"columns":["x","y"],"rows":[[1,"a"],[2,null]]}');
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.table.rows.map((row) => row.cells)).toEqual([["1", "a"], ["2", ""]]);
  });

  it("explains what is wrong", () => {
    expect(parseTableSpec("{nope")).toMatchObject({ error: expect.stringContaining("not valid JSON") });
    expect(parseTableSpec('{"rows":[]}')).toMatchObject({ error: expect.stringContaining("columns") });
    expect(parseTableSpec('{"columns":["a"]}')).toMatchObject({ error: expect.stringContaining("rows") });
    expect(parseTableSpec('{"columns":[{"key":"a","type":"emoji"}],"rows":[]}')).toMatchObject({ error: expect.stringContaining("emoji") });
  });
});

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

describe("link targets", () => {
  it("leaves web links and anchors alone", () => {
    expect(linkTargetOf("https://example.com/a")).toEqual({ kind: "web", href: "https://example.com/a" });
    expect(linkTargetOf("mailto:a@b.c")).toEqual({ kind: "web", href: "mailto:a@b.c" });
    expect(linkTargetOf("#intro")).toEqual({ kind: "web", href: "#intro" });
  });

  it("treats relative and absolute paths as workspace files and keeps the hash", () => {
    expect(linkTargetOf("out/report.html")).toEqual({ kind: "file", path: "out/report.html", hash: "" });
    expect(linkTargetOf("./my%20page.html#top")).toEqual({ kind: "file", path: "./my page.html", hash: "#top" });
    expect(linkTargetOf("C:\\Users\\me\\proj\\chart.html")).toEqual({ kind: "file", path: "C:\\Users\\me\\proj\\chart.html", hash: "" });
  });

  it("turns file URLs into paths", () => {
    expect(linkTargetOf("file:///C:/Users/me/a%20b.html")).toEqual({ kind: "file", path: "C:/Users/me/a b.html", hash: "" });
    expect(linkTargetOf("file:///home/me/a.html#x")).toEqual({ kind: "file", path: "/home/me/a.html", hash: "#x" });
  });
});

describe("csv file name", () => {
  it("slugs the title and falls back to table", () => {
    expect(csvFileName("Fruit stock, 2026!")).toBe("fruit-stock-2026.csv");
    expect(csvFileName("Цены")).toBe("цены.csv");
    expect(csvFileName(undefined)).toBe("table.csv");
    expect(csvFileName("???")).toBe("table.csv");
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
