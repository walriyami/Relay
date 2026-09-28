import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Value = SQLInputValue;

const SCHEMA_VERSION = 1;
/** Distinct SQL strings kept prepared; the application uses fewer, so dynamic SQL cannot grow it unboundedly. */
const STATEMENT_CACHE = 256;
/** Rows a batched delete removes per transaction. */
const DELETE_BATCH = 500;
const schema = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
const schemaQuery =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name";
let expectedSchema: string | undefined;
function schemaDefinition(sqlite: DatabaseSync) {
  return JSON.stringify(sqlite.prepare(schemaQuery).all());
}
function currentSchema() {
  if (expectedSchema) return expectedSchema;
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec(schema);
    return (expectedSchema = schemaDefinition(reference));
  } finally {
    reference.close();
  }
}

/**
 * The single connection to relay.sqlite.
 *
 * Concurrency model: the process is single-threaded and every statement is synchronous, so a
 * `tx()` callback (which must not await) is atomic with respect to all other request handling.
 * Filesystem changes inside a transaction must remain safe if it rolls back. Destructive cleanup
 * runs through `afterCommit()`, synchronously after the outer transaction commits.
 *
 * The connection holds SQLite's exclusive lock for its whole life. A second process opening the
 * same data directory fails at once, and the operating system releases the lock when this process
 * dies, so crash recovery needs no stale-lock timeout.
 */
export class Database {
  readonly sqlite: DatabaseSync;
  private committed: (() => void)[] | null = null;
  private readonly statements = new Map<string, StatementSync>();

  constructor(file: string) {
    this.sqlite = new DatabaseSync(file, { timeout: 0 });
    try {
      this.sqlite.exec(`
        PRAGMA locking_mode = EXCLUSIVE;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
      `);
      // Take the exclusive lock now rather than at the first write.
      this.sqlite.exec("BEGIN EXCLUSIVE; COMMIT;");
    } catch (error) {
      this.sqlite.close();
      if (/locked|busy/i.test(String((error as Error).message)))
        throw Object.assign(new Error("Another Relay process is using this data directory."), {
          code: "RELAY_LOCKED",
        });
      throw error;
    }
    try {
      this.initialize();
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  /** This unreleased product supports one schema. Never silently open incompatible or partial data. */
  private initialize() {
    const version = this.value<number>("PRAGMA user_version");
    const empty = !this.get("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1");
    if (empty && version === 0) {
      this.tx(() => this.sqlite.exec(`${schema}\nPRAGMA user_version = ${SCHEMA_VERSION};`));
      return;
    }
    if (version !== SCHEMA_VERSION || schemaDefinition(this.sqlite) !== currentSchema())
      throw Object.assign(
        new Error(
          "This data directory has an incompatible Relay schema. Relay has not changed your data. " +
            "Use the matching build to export it, or preserve a backup and start with a new empty directory. " +
            "Unreleased database formats are not migrated automatically.",
        ),
        { code: "RELAY_SCHEMA_INCOMPATIBLE" },
      );
  }

  /**
   * The prepared form of `sql`, reused across calls: a small upload runs dozens of statements, and
   * preparing each one again costs more than running it. Least recently used first out.
   */
  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement) this.statements.delete(sql);
    else {
      statement = this.sqlite.prepare(sql);
      if (this.statements.size >= STATEMENT_CACHE) this.statements.delete(this.statements.keys().next().value!);
    }
    this.statements.set(sql, statement);
    return statement;
  }

  get<T>(sql: string, ...args: Value[]): T | undefined {
    return this.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: Value[]): T[] {
    return this.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: Value[]): { changes: number } {
    const result = this.prepare(sql).run(...args);
    return { changes: Number(result.changes) };
  }
  /**
   * Deletes the rows of `table` that `where` matches, a bounded batch per transaction, and lets other
   * work run between batches: a backlog (after a long outage, say) never holds requests up for long.
   */
  async deleteBatched(table: string, where: string, ...args: Value[]) {
    const sql = `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${DELETE_BATCH})`;
    while (this.run(sql, ...args).changes >= DELETE_BATCH) await new Promise((resolve) => setImmediate(resolve));
  }
  /** A scalar from the first column of the first row. */
  value<T extends Value>(sql: string, ...args: Value[]): T | undefined {
    const row = this.prepare(sql).get(...args) as Record<string, T> | undefined;
    return row ? Object.values(row)[0] : undefined;
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. `fn` must be synchronous. */
  tx<T>(fn: () => T): T {
    if (this.committed) return fn();
    this.sqlite.exec("BEGIN IMMEDIATE");
    const committed: (() => void)[] = [];
    this.committed = committed;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) throw new Error("Database.tx callbacks must be synchronous.");
      this.sqlite.exec("COMMIT");
    } catch (error) {
      // SQLite can already have rolled back after FULL/IOERR. Preserve the original failure.
      if (this.sqlite.isTransaction) this.sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      this.committed = null;
    }
    // The transaction is already durable. A cleanup failure must neither roll it back nor prevent
    // other committed actions from running, and actions can start their own transactions.
    const errors: unknown[] = [];
    for (const action of committed) {
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Database committed, but post-commit actions failed.");
    return result;
  }

  /** Runs synchronous cleanup after the outermost commit, or now if no transaction is open. */
  afterCommit(fn: () => void) {
    if (this.committed) this.committed.push(fn);
    else fn();
  }

  setting(key: string): string | undefined {
    return this.value<string>("SELECT value FROM settings WHERE key = ?", key);
  }
  setSetting(key: string, value: string) {
    this.run(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  close() {
    this.statements.clear();
    if (this.sqlite.isOpen) this.sqlite.close();
  }
}

/** True for a UNIQUE constraint failure, which the API reports as a name conflict. */
export const isUniqueViolation = (error: unknown) => /UNIQUE constraint failed/.test(String((error as Error)?.message));
