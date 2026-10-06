import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["packages", "tests"];
const ALLOWED_DIRECTIVES = /^\/\/\s*(@ts-|eslint-)|^\/\*\s*(eslint-)/;

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (["node_modules", "dist"].includes(entry)) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });

const commentsIn = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Map<number, string>();
  const collect = (ranges: ts.CommentRange[] | undefined) => ranges?.forEach((range) => found.set(range.pos, text.slice(range.pos, range.end)));
  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found.values()].filter((comment) => !ALLOWED_DIRECTIVES.test(comment));
};

describe("code style", () => {
  it("source files contain no comments except tool directives", () => {
    const offenders = SOURCE_ROOTS.flatMap(sourceFiles).filter((path) => commentsIn(path).length > 0);
    expect(offenders).toEqual([]);
  });
});
