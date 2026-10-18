import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const KIT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RELATIVE_IMPORT = /from\s+["'](\.[^"']*)["']/g;

const kitSources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? kitSources(join(directory, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [join(directory, entry.name)] : [],
  );

describe("kit imports", () => {
  it("reach only files inside the kit folder", () => {
    const outside = kitSources(KIT_DIRECTORY).flatMap((source) =>
      [...readFileSync(source, "utf8").matchAll(RELATIVE_IMPORT)]
        .map((match) => ({ source, target: join(dirname(source), match[1] ?? "") }))
        .filter(({ target }) => !target.startsWith(KIT_DIRECTORY))
        .map(({ source: file, target }) => `${file} -> ${target}`),
    );
    expect(outside).toEqual([]);
  });
});
