import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION } from "@branchboard/core";
import { createApp } from "../packages/server/src/app";
import { DATABASE_NAME, EXPECTED_NAME, normaliseDocument } from "./fixtures/seed";

const FIXTURES = join(import.meta.dirname, "fixtures");
const scratch = mkdtempSync(join(tmpdir(), "branchboard-migrations-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const versions = readdirSync(FIXTURES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

const schemaVersionOf = (path: string): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  db.close();
  return user_version;
};

describe("released database fixtures", () => {
  it("has a fixture for the version being released", () => {
    const packaged = JSON.parse(readFileSync(join(import.meta.dirname, "..", "packages", "cli", "package.json"), "utf8")).version as string;
    expect(versions).toContain(packaged);
  });

  it.each(versions)("opens the %s database and exports the same boards", (version) => {
    const folder = mkdtempSync(join(scratch, `${version}-`));
    const databasePath = join(folder, DATABASE_NAME);
    copyFileSync(join(FIXTURES, version, DATABASE_NAME), databasePath);
    const storedVersion = schemaVersionOf(databasePath);

    const server = createApp({ databasePath, security: { port: 47191, extraOrigins: [] } });
    const documents = server.boards.listBoards().map((board) => server.boards.exportDocument(board.id));
    server.close();

    const expected = readFileSync(join(FIXTURES, version, EXPECTED_NAME), "utf8");
    expect(normaliseDocument(documents)).toBe(expected);
    expect(schemaVersionOf(databasePath)).toBe(LATEST_SCHEMA_VERSION);
    expect(existsSync(`${databasePath}.before-v${storedVersion + 1}`)).toBe(storedVersion < LATEST_SCHEMA_VERSION);
  });
});
