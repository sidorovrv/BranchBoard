import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importBoardDocument, isStale, normaliseKeybinds, parseChartSpec, parseTableSpec, SAMPLE_TITLES, shortcutRows, TOUR_STEPS, type GraphNode } from "@branchboard/core";
import sampleDocument from "../packages/web/src/assets/sample.branchboard.json" with { type: "json" };

const imported = importBoardDocument(JSON.stringify(sampleDocument));
const nodes = Object.values(imported.graph.nodes) as GraphNode[];
const titled = (title: string) => nodes.find((node) => node.title === title)!;

describe("sample board", () => {
  it("is a finished board with one stale answer, a code node, a summary and two rolls", () => {
    expect(isStale(imported.graph, titled(SAMPLE_TITLES.stale))).toBe(true);
    expect(isStale(imported.graph, titled(SAMPLE_TITLES.root))).toBe(false);
    expect(isStale(imported.graph, titled(SAMPLE_TITLES.compare))).toBe(false);
    expect(nodes.filter((node) => node.status !== "done" && node.kind === "turn")).toEqual([]);
    expect(titled(SAMPLE_TITLES.code).kind).toBe("code");
    expect(nodes.some((node) => node.summary)).toBe(true);
    expect(titled(SAMPLE_TITLES.python).rollCount).toBe(2);
  });

  it("carries no attachments, so nothing in it needs the server", () => {
    expect(nodes.some((node) => node.attachments?.length || node.sourceAttachmentId)).toBe(false);
    expect(Object.keys((sampleDocument as { files?: object }).files ?? {})).toEqual([]);
  });

  it("has an answer with a valid table block and a valid chart block", () => {
    const text = imported.parts[titled(SAMPLE_TITLES.compare).id].map((part) => part.text).join("\n");
    const block = (kind: string) => new RegExp(`\`\`\`${kind}\\n([\\s\\S]*?)\\n\`\`\``).exec(text)![1];
    expect(parseTableSpec(block("table"))).toHaveProperty("table");
    expect(parseChartSpec(block("chart"))).toHaveProperty("spec");
  });
});

describe("tour and shortcuts guide", () => {
  const webSource = (): string =>
    readdirSync(join(import.meta.dirname, "..", "packages", "web", "src"), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => readFileSync(join(import.meta.dirname, "..", "packages", "web", "src", file), "utf8"))
      .join("\n");

  it("has a data-tour anchor in the web source for every tour step", () => {
    const source = webSource();
    TOUR_STEPS.forEach((step) => expect(source, step.anchor).toMatch(new RegExp(`(data-tour|tourAnchor)=(\\{[^}]*)?"${step.anchor}"`)));
  });

  it("focuses only nodes that the sample board contains", () => {
    const titles = nodes.map((node) => node.title);
    TOUR_STEPS.filter((step) => step.focusTitle).forEach((step) => expect(titles).toContain(step.focusTitle));
  });

  it("covers code nodes, tables and charts", () => {
    const anchors = TOUR_STEPS.map((step) => step.anchor);
    expect(anchors).toEqual(expect.arrayContaining(["code", "table", "chart"]));
  });

  it("states actions plainly and makes no remarks about the sample itself", () => {
    const text = TOUR_STEPS.map((step) => `${step.title} ${step.body}`).join("\n");
    expect(text).not.toMatch(/for free|sample|without calling|re-runs by itself|keep every attempt/i);
  });

  it("lists the shortcuts guide action among the bound shortcuts", () => {
    const rows = shortcutRows(normaliseKeybinds({}));
    expect(rows.find((row) => row.text === "Show the shortcuts")?.keys).toBe("Shift+?");
    expect(rows.some((row) => row.keys === "Ctrl+A")).toBe(true);
  });
});
