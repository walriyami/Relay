import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type Value = SQLInputValue;

const SCHEMA_VERSION = 2;
// Exact v1 schema, with only the known users comment normalized below. Never infer a legacy
// schema from its version or a subset of columns: unrelated/partial formats must stay untouched.
const TIMESTAMP_SCHEMA = "3d3fac4594a8f3801114cb02a7ab048a092ff8d325df327d3500eb34a5cb5ee0";
const timestampComment = "-- Activity up to this time has been seen on some device of the account.";
const sequenceComment = "-- Activity through this durable insertion sequence has been read on an account device.";
/** Distinct SQL strings kept prepared; the application uses fewer, so dynamic SQL cannot grow it unboundedly. */
const STATEMENT_CACHE = 256;
/** Rows a batched delete removes per transaction. */
const DELETE_BATCH = 500;
const schema = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
const schemaQuery =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name";
let expectedSchema: string | undefined;
function schemaDefinition(sqlite: DatabaseSync) {
  const rows = sqlite.prepare(schemaQuery).all() as { type: string; name: string; sql: string }[];
  // SQLite retains comments inside CREATE TABLE. Preserve the users table and all its foreign
  // keys; recognize this one historical comment verbatim, without ignoring arbitrary SQL text.
  for (const row of rows)
    if (row.type === "table" && row.name === "users") row.sql = row.sql.replace(timestampComment, sequenceComment);
  return JSON.stringify(rows);
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

  /** Accept the exact current format or the one known Activity upgrade. Reject every unknown schema. */
  private initialize() {
    const version = this.value<number>("PRAGMA user_version");
    const empty = !this.get("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1");
    if (empty && version === 0) {
      this.tx(() => this.sqlite.exec(`${schema}\nPRAGMA user_version = ${SCHEMA_VERSION};`));
      return;
    }
    const definition = schemaDefinition(this.sqlite);
    if (version === 1 && createHash("sha256").update(definition).digest("hex") === TIMESTAMP_SCHEMA) {
      this.migrateActivity();
      return;
    }
    // The earlier Activity draft used the current sequence schema with user_version=1.
    if (version === 1 && definition === currentSchema()) {
      this.tx(() => this.sqlite.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`));
      return;
    }
    if (version !== SCHEMA_VERSION || definition !== currentSchema())
      throw Object.assign(
        new Error(
          "This data directory has an incompatible Relay schema. Relay has not changed your data. " +
            "Use the matching build to open it. Only the known v1 Activity schema can be upgraded automatically.",
        ),
        { code: "RELAY_SCHEMA_INCOMPATIBLE" },
      );
  }

  /** DDL, copied rows, converted watermarks and version all commit together, or all roll back. */
  private migrateActivity() {
    this.tx(() => {
      this.sqlite.exec(`
        DROP INDEX activity_owner;
        DROP INDEX activity_created;
        ALTER TABLE activity RENAME TO activity_v1;
      `);
      const activitySql = schema.match(
        /^CREATE TABLE activity \([\s\S]*?\) STRICT;[\s\S]*?^CREATE INDEX activity_created.*;$/m,
      )![0];
      this.sqlite.exec(activitySql);
      this.sqlite.exec(`
        INSERT INTO activity(id, owner, kind, by_device, created, data)
          SELECT id, owner, kind, by_device, created, data FROM activity_v1 ORDER BY created, rowid;
        UPDATE users SET activity_seen = COALESCE((
          SELECT MAX(sequence) FROM activity
          WHERE owner = users.id AND created < users.activity_seen AND users.activity_seen > 0
        ), 0);
        DROP TABLE activity_v1;
      `);
      // Legacy timestamps cannot identify which equal-time events preceded acknowledgement.
      // Leave that boundary unread once, rather than lose a later arrival at the same millisecond.
      if (schemaDefinition(this.sqlite) !== currentSchema() || this.get("PRAGMA foreign_key_check"))
        throw new Error("Activity migration validation failed; no changes were committed.");
      this.sqlite.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    });
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
