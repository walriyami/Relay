import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectedObjects, planUpgrade, sameSchema, SchemaRefused, schemaObjects } from "./schema.ts";

export type Value = SQLInputValue;

/** Marks a database as Relay's. Schema changes themselves are found by comparing with schema.sql. */
const SCHEMA_VERSION = 2;
/** Distinct SQL strings kept prepared; the application uses fewer, so dynamic SQL cannot grow it unboundedly. */
const STATEMENT_CACHE = 256;
/** Rows a batched delete removes per transaction. */
const DELETE_BATCH = 500;
const schemaFile = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");

/** SQLite's primary result codes for a storage that cannot be trusted or written. */
const STORAGE_FAILURES = new Set([8 /* READONLY */, 10 /* IOERR */, 11 /* CORRUPT */, 13 /* FULL */, 14, 26]);
const DAMAGED = new Set([11 /* CORRUPT */, 26 /* NOTADB */]);
const resultCode = (error: unknown) => Number((error as { errcode?: number })?.errcode) & 0xff;
const isDamage = (error: unknown) =>
  DAMAGED.has(resultCode(error)) || /malformed|not a database/i.test(String((error as Error)?.message));

export const DAMAGED_MESSAGE =
  "Relay's database file (relay.sqlite in the data folder) is damaged, so Relay has stopped rather than risk " +
  "making it worse. The stored files themselves are kept separately and have not been touched. " +
  'To recover, follow "If the database is damaged" in docs/hosting.md: stop Relay, keep a copy of the ' +
  "data folder, rebuild the database with SQLite's .recover command, and start Relay again.";

/** The database file failed SQLite's own checks. `detail` is SQLite's description, for the log. */
export class DatabaseDamaged extends Error {
  readonly code = "RELAY_DATABASE_DAMAGED";
  readonly detail: string;
  constructor(detail: string) {
    super(DAMAGED_MESSAGE);
    this.detail = detail;
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
  /** What opening this database changed to match schema.sql, for the startup log. */
  upgraded: string[] = [];
  /**
   * The last time the database refused a write or read because of its storage (full, read-only,
   * I/O error, damaged), until a later write succeeds. Health reports Relay unready meanwhile.
   */
  storageFailure: { at: number; message: string; damaged: boolean } | null = null;

  /** `schema` replaces schema.sql, for tests of upgrades. */
  constructor(file: string, { schema = schemaFile }: { schema?: string } = {}) {
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
      if (isDamage(error)) throw new DatabaseDamaged(String((error as Error).message));
      throw error;
    }
    try {
      this.initialize(schema);
      // Never committed with a row in it (see schema.sql); if one ever were, the checks below put
      // right whatever the triggers missed meanwhile.
      this.run("DELETE FROM deferred_totals");
      this.checkStoredTypes();
      this.checkHeldTotals();
      this.checkLinkTotals();
    } catch (error) {
      this.sqlite.close();
      if (isDamage(error)) throw new DatabaseDamaged(String((error as Error).message));
      throw error;
    }
  }

  /** True when stored_types was rebuilt at startup. */
  rebuiltStoredTypes = false;

  /**
   * stored_types is kept by triggers, like users.bytes_used. When the two disagree (the table is
   * new to this database, or something changed one without the other), it is rebuilt from the nodes:
   * one pass over every file, only then.
   */
  private checkStoredTypes() {
    const differs = this.get(
      `SELECT 1 FROM users u
       WHERE u.bytes_used <> (SELECT ifnull(sum(bytes), 0) FROM stored_types s WHERE s.owner = u.id)
          OR (u.bytes_used = 0 AND NOT EXISTS (SELECT 1 FROM stored_types s WHERE s.owner = u.id)
              AND EXISTS (SELECT 1 FROM nodes n WHERE n.owner = u.id AND n.state = 'ready' AND n.kind = 'file'))
       LIMIT 1`,
    );
    if (!differs) return;
    this.tx(() => {
      this.run("DELETE FROM stored_types");
      this.run(
        `INSERT INTO stored_types(owner, mime, bytes, files)
         SELECT owner, mime, sum(size), sum(kind = 'file') FROM nodes
         WHERE state = 'ready' AND kind <> 'folder' GROUP BY owner, mime`,
      );
    });
    this.rebuiltStoredTypes = true;
  }

  /** Members and requests whose held totals were corrected at startup. */
  correctedHeldTotals = 0;

  /**
   * The totals of what unfinished uploads hold (users.reserved_bytes and the rest, kept by the
   * held_* triggers) are worked out again from the uploads themselves, and any that differ are
   * corrected: when the columns are new to this database, or anything ever changed one without the
   * other. requests.held_entries and held_bytes are checked the same way against their submissions.
   */
  private checkHeldTotals() {
    type Totals = { reserved: number; visitorUnsent: number; unsentMember: number; unsentVisitor: number };
    const expected = new Map<string, Totals>();
    const add = (owner: string, key: keyof Totals, bytes: number) => {
      const totals = expected.get(owner) ?? { reserved: 0, visitorUnsent: 0, unsentMember: 0, unsentVisitor: 0 };
      totals[key] += bytes;
      expected.set(owner, totals);
    };
    for (const row of this.all<{ owner: string; bytes: number }>(
      "SELECT owner, sum(size) AS bytes FROM nodes WHERE state = 'pending' GROUP BY owner",
    ))
      add(row.owner, "reserved", row.bytes);
    for (const row of this.all<{ owner: string; bytes: number }>(
      `SELECT t.owner, sum(n.size - u.offset) AS bytes FROM nodes n JOIN uploads u ON u.node = n.id
       JOIN transfers t ON t.id = u.transfer WHERE n.state = 'pending' AND t.principal LIKE 'grant:%' GROUP BY t.owner`,
    ))
      add(row.owner, "visitorUnsent", row.bytes);
    for (const row of this.all<{ owner: string; visitor: number; bytes: number }>(
      `SELECT t.owner, t.principal LIKE 'grant:%' AS visitor, sum(u.size - u.offset) AS bytes
       FROM transfers t JOIN uploads u ON u.transfer = t.id
       WHERE t.state = 'open' AND u.completed IS NULL AND u.node IS NOT NULL GROUP BY t.owner, visitor`,
    ))
      add(row.owner, row.visitor ? "unsentVisitor" : "unsentMember", row.bytes);
    const stored = this.all<{ id: string } & Totals>(
      `SELECT id, reserved_bytes AS reserved, reserved_visitor_unsent AS visitorUnsent,
         unsent_member AS unsentMember, unsent_visitor AS unsentVisitor FROM users`,
    );
    const wrong = stored.filter((row) => {
      const want = expected.get(row.id);
      return (
        row.reserved !== (want?.reserved ?? 0) ||
        row.visitorUnsent !== (want?.visitorUnsent ?? 0) ||
        row.unsentMember !== (want?.unsentMember ?? 0) ||
        row.unsentVisitor !== (want?.unsentVisitor ?? 0)
      );
    });
    const requests = this.all<{ id: string; entries: number; bytes: number }>(
      `SELECT r.id, coalesce(h.entries, 0) AS entries, coalesce(h.bytes, 0) AS bytes FROM requests r
       LEFT JOIN (SELECT i.request_id, count(*) AS entries, sum(n.size) AS bytes FROM items i
         JOIN nodes n ON n.item = i.id WHERE i.request_id IS NOT NULL GROUP BY i.request_id) h ON h.request_id = r.id
       WHERE r.held_entries <> coalesce(h.entries, 0) OR r.held_bytes <> coalesce(h.bytes, 0)`,
    );
    if (!wrong.length && !requests.length) return;
    this.tx(() => {
      for (const row of requests)
        this.run("UPDATE requests SET held_entries = ?, held_bytes = ? WHERE id = ?", row.entries, row.bytes, row.id);
      for (const row of wrong) {
        const want = expected.get(row.id);
        this.run(
          `UPDATE users SET reserved_bytes = ?, reserved_visitor_unsent = ?, unsent_member = ?, unsent_visitor = ?
           WHERE id = ?`,
          want?.reserved ?? 0,
          want?.visitorUnsent ?? 0,
          want?.unsentMember ?? 0,
          want?.unsentVisitor ?? 0,
          row.id,
        );
      }
    });
    this.correctedHeldTotals = wrong.length + requests.length;
  }

  /**
   * links.visitors, downloads and last_visit (kept by the link_visits triggers) count everyone a link
   * ever let in, so they never fall below what its visits add up to. Any that do, as when the columns
   * are new to this database, are raised to it.
   */
  private checkLinkTotals() {
    this.run(
      `UPDATE links SET visitors = max(links.visitors, v.visitors), downloads = max(links.downloads, v.downloads),
         last_visit = max(ifnull(links.last_visit, 0), v.last)
       FROM (SELECT link, count(*) AS visitors, sum(downloads) AS downloads, max(last) AS last
             FROM link_visits GROUP BY link) AS v
       WHERE links.id = v.link
         AND (links.visitors < v.visitors OR links.downloads < v.downloads OR ifnull(links.last_visit, 0) < v.last)`,
    );
  }

  /** Notes storage failures so health can report them; every statement passes through here. */
  private watch<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (STORAGE_FAILURES.has(resultCode(error)) || isDamage(error))
        this.storageFailure = { at: Date.now(), message: String((error as Error).message), damaged: isDamage(error) };
      throw error;
    }
  }

  /**
   * Creates an empty database from schema.sql, or brings an existing one up to it (see schema.ts).
   * A damaged file or a refused change stops here, before anything is written.
   */
  private initialize(schema: string) {
    const version = this.value<number>("PRAGMA user_version")!;
    const empty = !this.get("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1");
    if (empty && version === 0) {
      this.tx(() => this.sqlite.exec(`${schema}\nPRAGMA user_version = ${SCHEMA_VERSION};`));
      return;
    }
    if (version < 1 || version > SCHEMA_VERSION)
      throw new SchemaRefused(
        version > SCHEMA_VERSION
          ? "This data folder was last used by a newer version of Relay. Relay has not changed your data. " +
              "Run that newer version again."
          : "This data folder holds a database that Relay did not create. Relay has not changed it. " +
              "Point Relay at its own data folder, or at a new empty one.",
      );
    // A quick structural check of every page: cheap next to a full integrity check, and it finds
    // the damage a failing SD card or an interrupted copy leaves before Relay builds on it.
    const problems = this.all<{ quick_check: string }>("PRAGMA quick_check(5)").map((r) => r.quick_check);
    if (problems.join() !== "ok") throw new DatabaseDamaged(problems.join("; "));
    const plan = planUpgrade(schemaObjects(this.sqlite), expectedObjects(schema));
    if (!plan.statements.length && version === SCHEMA_VERSION) return;
    this.tx(() => {
      for (const statement of plan.statements) this.sqlite.exec(statement);
      this.sqlite.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      // An addition SQLite accepted but that still differs (a column it rewrote) must not half-apply.
      if (!sameSchema(schemaObjects(this.sqlite), expectedObjects(schema)))
        throw new SchemaRefused(
          `Relay couldn't bring the database up to date (${plan.changes.join(", ")}). Relay has not changed your data.`,
        );
    });
    this.upgraded = plan.changes;
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
    return this.watch(() => this.prepare(sql).get(...args) as T | undefined);
  }
  all<T>(sql: string, ...args: Value[]): T[] {
    return this.watch(() => this.prepare(sql).all(...args) as T[]);
  }
  run(sql: string, ...args: Value[]): { changes: number } {
    const result = this.watch(() => this.prepare(sql).run(...args));
    // A write outside a transaction commits by itself.
    if (!this.sqlite.isTransaction && this.storageFailure && !this.storageFailure.damaged) this.storageFailure = null;
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
    const row = this.watch(() => this.prepare(sql).get(...args) as Record<string, T> | undefined);
    return row ? Object.values(row)[0] : undefined;
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. `fn` must be synchronous. */
  tx<T>(fn: () => T): T {
    if (this.committed) return fn();
    this.watch(() => this.sqlite.exec("BEGIN IMMEDIATE"));
    const committed: (() => void)[] = [];
    this.committed = committed;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) throw new Error("Database.tx callbacks must be synchronous.");
      this.watch(() => this.sqlite.exec("COMMIT"));
      if (this.storageFailure && !this.storageFailure.damaged) this.storageFailure = null;
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
