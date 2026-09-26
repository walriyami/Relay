import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Value = SQLInputValue;

/** Bump this, and add an upgrade step here, whenever schema.sql changes after a release. */
const SCHEMA_VERSION = 1;

/**
 * The single connection to relay.sqlite.
 *
 * Concurrency model: the process is single-threaded and every statement is synchronous, so a
 * `tx()` callback (which must not await) is atomic with respect to all other request handling.
 * Code that must keep the database and the filesystem in step does both inside one synchronous
 * block, so no other handler can observe the state in between.
 *
 * The connection holds SQLite's exclusive lock for its whole life. A second process opening the
 * same data directory fails at once, and the operating system releases the lock when this process
 * dies, so crash recovery needs no stale-lock timeout.
 */
export class Database {
  readonly sqlite: DatabaseSync;
  private depth = 0;

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

  /** Creates the schema in a new database, and refuses one made by a different schema version. */
  private initialize() {
    const version = Number(this.get<{ user_version: number }>("PRAGMA user_version")!.user_version);
    if (version === SCHEMA_VERSION) return;
    if (version !== 0)
      throw new Error(`This database has schema version ${version}, but this Relay build expects ${SCHEMA_VERSION}.`);
    this.tx(() => {
      this.sqlite.exec(readFileSync(join(import.meta.dirname, "schema.sql"), "utf8"));
      this.sqlite.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  get<T>(sql: string, ...args: Value[]): T | undefined {
    return this.sqlite.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: Value[]): T[] {
    return this.sqlite.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: Value[]): { changes: number } {
    const result = this.sqlite.prepare(sql).run(...args);
    return { changes: Number(result.changes) };
  }
  /** A scalar from the first column of the first row. */
  value<T extends Value>(sql: string, ...args: Value[]): T | undefined {
    const row = this.sqlite.prepare(sql).get(...args) as Record<string, T> | undefined;
    return row ? Object.values(row)[0] : undefined;
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. `fn` must be synchronous. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.sqlite.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error("Database.tx callbacks must be synchronous.");
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
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
    this.sqlite.close();
  }
}

/** True for a UNIQUE constraint failure, which the API reports as a name conflict. */
export const isUniqueViolation = (error: unknown) => /UNIQUE constraint failed/.test(String((error as Error)?.message));
