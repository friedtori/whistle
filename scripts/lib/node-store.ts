/**
 * Node-only stand-in for the Worker's D1 binding, used by the seed scripts
 * (`dump:seed-cases`, `replay:seed-archive --live`). It implements the small
 * part of the D1 API that src/db.ts uses on top of node:sqlite and applies
 * the same migrations/ as production. Not used by the Worker or by tests.
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1Store } from "../../src/db.ts";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");

class NodeStatement {
  constructor(
    readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): NodeStatement {
    return new NodeStatement(this.db, this.sql, values.map((v) => (v === undefined ? null : v)) as SQLInputValue[]);
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: object }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }

  async run(): Promise<{ results: never[]; success: true; meta: object }> {
    this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: {} };
  }

  execRows(): unknown[] {
    const stmt = this.db.prepare(this.sql);
    return /^\s*(SELECT|WITH)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)
      ? stmt.all(...this.params)
      : (stmt.run(...this.params), []);
  }
}

class NodeD1 {
  readonly raw: DatabaseSync;

  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON;");
    for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
      this.raw.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
    }
  }

  prepare(sql: string): NodeStatement {
    return new NodeStatement(this.raw, sql);
  }

  async batch(statements: NodeStatement[]) {
    this.raw.exec("BEGIN");
    try {
      const out = statements.map((stmt) => ({ results: stmt.execRows(), success: true, meta: {} }));
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function createNodeStore(path = ":memory:"): D1Store & { close(): void } {
  const d1 = new NodeD1(path);
  const store = new D1Store(d1 as unknown as D1Database) as D1Store & { close(): void };
  store.close = () => d1.close();
  return store;
}
