import { describe, expect, it } from "vitest";
import { linkTargetOf } from "./links";

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
