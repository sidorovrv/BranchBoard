import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Table = "boards" | "nodes" | "edges" | "parts" | "requests" | "projects";

const TABLES: Table[] = ["boards", "nodes", "edges", "parts", "requests", "projects"];

const FIRST_TABLES: Table[] = ["boards", "nodes", "edges", "parts", "requests"];

const MIGRATIONS: string[][] = [
  FIRST_TABLES.map((table) => `CREATE TABLE ${table} (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, data TEXT NOT NULL)`).concat(
    FIRST_TABLES.map((table) => `CREATE INDEX ${table}_board ON ${table}(board_id)`),
  ),
  ["CREATE TABLE projects (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, data TEXT NOT NULL)"],
];

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

const migrate = (db: DatabaseSync) => {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  MIGRATIONS.slice(current).forEach((statements, offset) => {
    inTransaction(db, () => {
      statements.forEach((statement) => db.exec(statement));
      db.exec(`PRAGMA user_version = ${current + offset + 1}`);
    });
  });
};

const parseRows = <T>(rows: unknown[]): T[] => (rows as { data: string }[]).map((row) => JSON.parse(row.data) as T);

export const openRepository = (path: string): Repository => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
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
