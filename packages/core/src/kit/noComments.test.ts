import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["packages", "src", "tests"].filter((root) => existsSync(root));
const ALLOWED_DIRECTIVES = /^\/\/\s*(@ts-|eslint-)|^\/\/\/\s*<reference|^\/\*\s*(eslint-)/;

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (["node_modules", "dist"].includes(entry)) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });

const commentsIn = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  return parseSync(path, text)
    .comments.map((comment) => text.slice(comment.start, comment.end))
    .filter((comment) => !ALLOWED_DIRECTIVES.test(comment));
};

describe("code style", () => {
  it("source files contain no comments except tool directives", () => {
    const offenders = SOURCE_ROOTS.flatMap(sourceFiles).filter((path) => commentsIn(path).length > 0);
    expect(offenders).toEqual([]);
  });
});
