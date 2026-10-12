import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_STEPS, stepsAbove, type SchemaStep } from "@branchboard/core";

export type Table = "boards" | "nodes" | "edges" | "parts" | "requests" | "projects";

const TABLES: Table[] = ["boards", "nodes", "edges", "parts", "requests", "projects"];

const KEPT_BACKUPS = 2;
const BACKUP_SUFFIX = ".before-v";

export interface Row {
  id: string;
}

export interface Repository {
  get<T extends Row>(table: Table, id: string): T | undefined;
  list<T extends Row>(table: Table, boardId: string): T[];
  listAll<T extends Row>(table: Table): T[];
  upsertMany<T extends Row>(table: Table, boardId: (row: T) => string, rows: T[]): void;
  remove(table: Table, ids: string[]): void;
  removeBoardRows(boardId: string): void;
  checkpoint(): void;
  close(): void;
}

const inTransaction = <T>(db: DatabaseSync, work: () => T): T => {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const REWRITTEN_TABLES = ["nodes", "parts", "edges"] as const;

const rewriteRows = (db: DatabaseSync, rewrite: NonNullable<SchemaStep["rewrite"]>) =>
  REWRITTEN_TABLES.forEach((table) => {
    const rewriteRow = rewrite[table] as ((row: unknown) => unknown) | undefined;
    if (!rewriteRow) return;
    const update = db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`);
    (db.prepare(`SELECT id, data FROM ${table}`).all() as { id: string; data: string }[]).forEach((row) =>
      update.run(JSON.stringify(rewriteRow(JSON.parse(row.data))), row.id),
    );
  });

const backupBeforeMigrating = (db: DatabaseSync, path: string, targetVersion: number) => {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(path, `${path}${BACKUP_SUFFIX}${targetVersion}`);
  const stem = basename(path) + BACKUP_SUFFIX;
  const versionOf = (name: string) => Number(name.slice(stem.length));
  readdirSync(dirname(path))
    .filter((name) => name.startsWith(stem) && Number.isInteger(versionOf(name)))
    .sort((a, b) => versionOf(b) - versionOf(a))
    .slice(KEPT_BACKUPS)
    .forEach((name) => rmSync(join(dirname(path), name), { force: true }));
};

const migrate = (db: DatabaseSync, path: string, steps: SchemaStep[]) => {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const pending = stepsAbove(current, steps);
  if (!pending.length) return;
  if (current > 0 && path !== ":memory:") backupBeforeMigrating(db, path, pending[0].to);
  inTransaction(db, () => {
    pending.forEach((step) => {
      step.ddl?.forEach((statement) => db.exec(statement));
      if (step.rewrite) rewriteRows(db, step.rewrite);
    });
    db.exec(`PRAGMA user_version = ${pending[pending.length - 1].to}`);
  });
};

const parseRows = <T>(rows: unknown[]): T[] => (rows as { data: string }[]).map((row) => JSON.parse(row.data) as T);

export const openRepository = (path: string, steps: SchemaStep[] = SCHEMA_STEPS): Repository => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db, path, steps);
  const upsertStatements = Object.fromEntries(
    TABLES.map((table) => [table, db.prepare(`INSERT INTO ${table}(id, board_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`)]),
  );
  return {
    get: <T extends Row>(table: Table, id: string) => {
      const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as T) : undefined;
    },
    list: <T extends Row>(table: Table, boardId: string) => parseRows<T>(db.prepare(`SELECT data FROM ${table} WHERE board_id = ?`).all(boardId)),
    listAll: <T extends Row>(table: Table) => parseRows<T>(db.prepare(`SELECT data FROM ${table}`).all()),
    upsertMany: <T extends Row>(table: Table, boardId: (row: T) => string, rows: T[]) => {
      inTransaction(db, () => rows.forEach((row) => upsertStatements[table].run(row.id, boardId(row), JSON.stringify(row))));
    },
    remove: (table: Table, ids: string[]) => {
      const statement = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      inTransaction(db, () => ids.forEach((id) => statement.run(id)));
    },
    removeBoardRows: (boardId: string) => {
      inTransaction(db, () => TABLES.filter((table) => table !== "projects").forEach((table) => db.prepare(`DELETE FROM ${table} WHERE ${table === "boards" ? "id" : "board_id"} = ?`).run(boardId)));
    },
    checkpoint: () => void db.exec("PRAGMA wal_checkpoint(TRUNCATE)"),
    close: () => db.close(),
  };
};
