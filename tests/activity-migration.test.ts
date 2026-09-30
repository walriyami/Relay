import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Database } from "../server/db/database.ts";
import { api, urls } from "../shared/api.ts";
import { admin, Client, member, send, start, stop, type Instance } from "./support/harness.ts";

// Frozen from main 1b8abd2, independently of the current schema and migration implementation.
const v1 = readFileSync(join(import.meta.dirname, "fixtures/schema-v1.sql"), "utf8");
const timestampComment = "-- Activity up to this time has been seen on some device of the account.";
const sequenceComment = "-- Activity through this durable insertion sequence has been read on an account device.";
const schemaRows = (db: DatabaseSync) =>
  db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all();
function contents(db: DatabaseSync) {
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      db
        .prepare(`SELECT * FROM ${name} ORDER BY 1`)
        .all()
        .map((row) => ({ ...row })),
    ]),
  ) as Record<string, Record<string, SQLInputValue>[]>;
}
function legacy(path: string, comment = timestampComment) {
  const db = new DatabaseSync(path);
  // Fixture import order is independent of foreign-key order. Production startup enables keys.
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec(v1.replace(timestampComment, comment));
  db.exec("PRAGMA user_version=1;");
  return db;
}
function seedEvents(db: DatabaseSync, at: number) {
  db.prepare("INSERT INTO users(id, username, password_hash, activity_seen, created) VALUES(?,?,?,?,?)").run(
    "owner",
    "owner",
    "synthetic-hash",
    at,
    at,
  );
  db.prepare("INSERT INTO users(id, username, password_hash, activity_seen, created) VALUES(?,?,?,?,?)").run(
    "other",
    "other",
    "synthetic-hash",
    0,
    at,
  );
  const insert = db.prepare("INSERT INTO activity(id,owner,kind,created,data) VALUES(?,?,'upload',?,?)");
  // Clock rollback and interleaving: migration must sort by time, then original rowid at ties.
  for (const [id, owner, created] of [
    ["unread", "owner", at + 1],
    ["boundary-before-ack", "owner", at],
    ["other-old", "other", at - 5],
    ["read", "owner", at - 1],
    ["boundary-after-ack", "owner", at],
  ] as const)
    insert.run(id, owner, created, JSON.stringify({ kind: "upload", request: id }));
}

test("exact v1 upgrades preserve all existing rows, account data and saved bytes; repeated app restarts are idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-v1-preserve-"));
  const seedRoot = join(root, "seed");
  const target = join(root, "existing-v1");
  let instance: Instance | undefined;
  try {
    // Populate ordinary data using the actual API, then import its rows into an independent v1
    // fixture. The migration never sees the seed directory or replaces an existing database.
    instance = await start({}, seedRoot);
    const boss = await admin(instance);
    const owner = await member(instance, "migration-owner", boss);
    const ownerId = (await owner.call(api.session.get)).user.id;
    await owner.call(api.account.update, {
      body: { name: "Preserved owner", trashDays: 45, prefs: { linkDays: 3, autoCopyLink: false } },
    });
    const payload = Buffer.from("Saved synthetic content\u0000\u00ff", "utf8");
    const { result } = await send(owner, [{ path: "records/statement.bin", data: payload }], { text: "Saved note" });
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Preserved request", description: "Keep this", days: 5, maxBytes: 1000 },
    });
    const nodes = (await owner.call(api.items.get, { params: { id: result.itemId } })).nodes;
    const file = nodes.find((node) => node.kind === "file")!;
    const blob = instance.ctx.db.value<string>("SELECT blob FROM nodes WHERE id=?", file.id)!;
    const blobRelative = join("blobs", blob.slice(0, 2), blob.slice(2, 4), blob);
    const cookies = [...owner.cookies];
    const csrf = owner.csrf;
    await stop(instance);
    instance = undefined;
    await cp(join(seedRoot, "blobs"), join(target, "blobs"), { recursive: true });
    const source = new DatabaseSync(join(seedRoot, "relay.sqlite"), { readOnly: true });
    const raw = legacy(join(target, "relay.sqlite"));
    try {
      // Temporarily suspend fixture triggers while importing already-accounted rows, then
      // restore their exact historical SQL. Foreign keys are checked after the import.
      const triggers = raw.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'").all() as {
        name: string;
        sql: string;
      }[];
      raw.exec("BEGIN;");
      for (const trigger of triggers) raw.exec(`DROP TRIGGER ${trigger.name}`);
      for (const [table, rows] of Object.entries(contents(source))) {
        for (const row of rows) {
          if (table === "activity") delete row.sequence;
          const columns = Object.keys(row);
          raw
            .prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
            .run(...Object.values(row));
        }
      }
      for (const trigger of triggers) raw.exec(trigger.sql);
      // Model two legacy timestamp watermarks, including zero/no previously read events.
      const at = Date.now();
      raw.prepare("UPDATE users SET activity_seen=? WHERE id=?").run(at + 1, ownerId);
      raw.prepare("UPDATE users SET activity_seen=0 WHERE id<>?").run(ownerId);
      raw.exec("COMMIT;");
      assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      source.close();
      raw.close();
    }
    const path = join(target, "relay.sqlite");
    const beforeDb = new DatabaseSync(path);
    const before = contents(beforeDb);
    const userSql = beforeDb.prepare("SELECT sql FROM sqlite_schema WHERE name='users'").get()?.sql;
    beforeDb.close();
    const blobPath = join(target, blobRelative);
    const inode = statSync(blobPath).ino;
    let migrated = new Database(path);
    const after = contents(migrated.sqlite);
    for (const [table, rows] of Object.entries(before)) {
      if (table === "activity") {
        assert.deepEqual(
          after.activity
            .map(({ sequence: _sequence, ...row }) => row)
            .sort((a, b) => (a.id as string).localeCompare(b.id as string)),
          rows.sort((a, b) => (a.id as string).localeCompare(b.id as string)),
        );
      } else if (table === "users") {
        assert.deepEqual(
          after.users.map(({ activity_seen: _marker, ...row }) => row),
          rows.map(({ activity_seen: _marker, ...row }) => row),
        );
      } else assert.deepEqual(after[table], rows, `${table} unchanged`);
    }
    assert.equal(migrated.value("PRAGMA user_version"), 2);
    assert.equal(migrated.value("SELECT sql FROM sqlite_schema WHERE name='users'"), userSql, "users not rebuilt");
    assert.deepEqual(migrated.all("PRAGMA foreign_key_check"), []);
    assert.equal(migrated.value("PRAGMA integrity_check"), "ok");
    const newest = migrated.value<number>("SELECT MAX(sequence) FROM activity WHERE owner=?", ownerId)!;
    assert.equal(migrated.value("SELECT activity_seen FROM users WHERE id=?", ownerId), newest);
    assert.equal(migrated.value("SELECT activity_seen FROM users WHERE id<>?", ownerId), 0);
    const converted = contents(migrated.sqlite);
    migrated.close();
    migrated = new Database(path);
    assert.deepEqual(contents(migrated.sqlite), converted, "second database open does not reconvert markers");
    migrated.close();
    for (let restart = 0; restart < 2; restart++) {
      instance = await start({}, target);
      const resumed = new Client(instance);
      for (const [name, value] of cookies) resumed.cookies.set(name, value);
      resumed.csrf = csrf;
      assert.equal((await resumed.call(api.session.get)).user.name, "Preserved owner");
      const content = await resumed.raw({ method: "GET", url: urls.nodeContent(file.id) });
      assert.equal(content.statusCode, 200);
      assert.deepEqual(content.rawPayload, payload);
      assert.equal((await resumed.call(api.items.get, { params: { id: result.itemId } })).nodes.length, nodes.length);
      assert.ok((await resumed.call(api.links.list)).some((entry) => entry.id === link.id && entry.available));
      assert.ok((await resumed.call(api.requests.list)).some((entry) => entry.name === "Preserved request"));
      assert.equal((await resumed.call(api.activity.list)).seen, newest);
      if (restart === 0) {
        const tiedTime = (await resumed.call(api.activity.list)).entries[0].created;
        t.mock.method(Date, "now", () => tiedTime);
        await resumed.call(api.activity.seen, { body: { until: newest } });
        instance.ctx.activity.record(ownerId, {
          kind: "upload",
          requestId: "fixture-request",
          request: "After migrated acknowledgement",
          sender: null,
          itemId: result.itemId,
          files: 1,
          bytes: payload.length,
          text: false,
        });
        const later = await resumed.call(api.activity.list);
        assert.equal(later.entries[0].created, tiedTime);
        assert.ok(later.entries[0].sequence > later.seen);
        assert.equal(later.entries.filter((entry) => !entry.self && entry.sequence > later.seen).length, 1);
        await resumed.call(api.activity.seen, { body: { until: newest } });
        assert.equal((await resumed.call(api.activity.list)).seen, newest, "stale ack cannot read the tied arrival");
        t.mock.restoreAll();
      } else {
        assert.equal(
          (await resumed.call(api.activity.list)).entries.filter((entry) => !entry.self && entry.sequence > newest)
            .length,
          1,
          "post-migration same-time unread survives an app restart",
        );
      }
      assert.deepEqual(readFileSync(blobPath), payload);
      assert.equal(statSync(blobPath).ino, inode, "saved file was not replaced");
      await stop(instance);
      instance = undefined;
    }
  } finally {
    t.mock.restoreAll();
    if (instance) await stop(instance);
    await rm(root, { recursive: true, force: true });
  }
});

for (const comment of [timestampComment, sequenceComment]) {
  test(`v1 timestamp conversion recognizes only its known users comment: ${comment}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-v1-marker-"));
    const path = join(root, "relay.sqlite");
    let migrated: Database | undefined;
    try {
      const raw = legacy(path, comment);
      const at = Date.now();
      seedEvents(raw, at);
      // No retained activity after old acknowledgements: restart must not keep a timestamp-sized marker.
      raw
        .prepare("INSERT INTO users(id,username,password_hash,activity_seen,created) VALUES(?,?,?,?,?)")
        .run("empty", "empty", "synthetic-hash", at + 100, at);
      raw.close();
      migrated = new Database(path);
      const marker = migrated.value<number>("SELECT activity_seen FROM users WHERE id='owner'")!;
      const entries = migrated.all<{ id: string; sequence: number }>(
        "SELECT id, sequence FROM activity ORDER BY sequence",
      );
      assert.deepEqual(
        entries.map((entry) => entry.id),
        ["other-old", "read", "boundary-before-ack", "boundary-after-ack", "unread"],
      );
      assert.equal(marker, entries.find((entry) => entry.id === "read")!.sequence);
      assert.deepEqual(
        entries.filter((entry) => entry.sequence > marker).map((entry) => entry.id),
        ["boundary-before-ack", "boundary-after-ack", "unread"],
      );
      assert.equal(migrated.value("SELECT activity_seen FROM users WHERE id='other'"), 0);
      assert.equal(migrated.value("SELECT activity_seen FROM users WHERE id='empty'"), 0);
      // Once the boundary is explicitly read by sequence, an equal-time later event remains new.
      const until = entries.at(-1)!.sequence;
      migrated.run("UPDATE users SET activity_seen=? WHERE id='owner'", until);
      migrated.run(
        "INSERT INTO activity(id,owner,kind,created,data) VALUES('post-ack','owner','upload',?,?)",
        at,
        JSON.stringify({ kind: "upload", request: "post-ack" }),
      );
      assert.ok(migrated.value<number>("SELECT sequence FROM activity WHERE id='post-ack'")! > until);
      const snapshot = contents(migrated.sqlite);
      migrated.close();
      migrated = new Database(path);
      assert.deepEqual(contents(migrated.sqlite), snapshot);
    } finally {
      migrated?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const stage of ["table rebuild", "marker conversion", "version update", "commit"] as const) {
  test(`v1 migration rolls back ${stage} failure, preserves the exact old database and can retry`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "relay-v1-rollback-"));
    const path = join(root, "relay.sqlite");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with its original SQLite receiver.
    const exec = DatabaseSync.prototype.exec;
    try {
      const raw = legacy(path);
      seedEvents(raw, Date.now());
      const before = contents(raw);
      const beforeSchema = schemaRows(raw);
      raw.close();
      const injected = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
        if (stage === "commit" && sql === "COMMIT") throw new Error("injected migration failure");
        const result = exec.call(this, sql);
        if (
          (stage === "table rebuild" && sql.startsWith("CREATE TABLE activity (")) ||
          (stage === "marker conversion" && sql.includes("DROP TABLE activity_v1")) ||
          (stage === "version update" && sql === "PRAGMA user_version = 2;")
        )
          throw new Error("injected migration failure");
        return result;
      });
      assert.throws(() => new Database(path), /injected migration failure/);
      injected.mock.restore();
      const check = new DatabaseSync(path);
      assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 1);
      assert.deepEqual(schemaRows(check), beforeSchema, "DDL rolled back, including users SQL and Activity indexes");
      assert.deepEqual(contents(check), before, "every old row and timestamp marker preserved");
      check.close();
      const retry = new Database(path);
      assert.equal(retry.value("PRAGMA user_version"), 2);
      assert.equal(retry.value("SELECT COUNT(*) FROM activity"), before.activity.length);
      retry.close();
    } finally {
      t.mock.restoreAll();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const failure of ["copy constraint", "final validation"] as const) {
  test(`v1 ${failure} failure rolls back earlier inserts and releases the startup lock`, async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-v1-invalid-"));
    const path = join(root, "relay.sqlite");
    try {
      const raw = legacy(path);
      seedEvents(raw, Date.now());
      if (failure === "copy constraint")
        raw
          .prepare("INSERT INTO activity(id,owner,kind,created,data) VALUES('orphan','missing','upload',?, '{}')")
          .run(Date.now() + 100);
      else
        raw.exec(
          "INSERT INTO devices(id,user_id,name,kind,created,seen) VALUES('orphan','missing','Synthetic','computer',1,1)",
        );
      const before = contents(raw);
      const beforeSchema = schemaRows(raw);
      raw.close();
      assert.throws(
        () => new Database(path),
        failure === "copy constraint" ? /FOREIGN KEY constraint failed/ : /Activity migration validation failed/,
      );
      const check = new DatabaseSync(path);
      assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 1);
      assert.deepEqual(schemaRows(check), beforeSchema);
      assert.deepEqual(contents(check), before);
      check.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a real SQLITE_FULL during migration leaves the legacy schema and rows intact and permits retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-v1-full-"));
  const path = join(root, "relay.sqlite");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with its original SQLite receiver.
  const exec = DatabaseSync.prototype.exec;
  try {
    const raw = legacy(path);
    seedEvents(raw, Date.now());
    raw
      .prepare("UPDATE activity SET data=? WHERE id='unread'")
      .run(JSON.stringify({ kind: "upload", request: "Synthetic large event ".repeat(30_000) }));
    const before = contents(raw);
    const beforeSchema = schemaRows(raw);
    raw.close();
    const limited = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql.includes("ALTER TABLE activity RENAME TO activity_v1")) {
        const pages = this.prepare("PRAGMA page_count").get()?.page_count as number;
        exec.call(this, `PRAGMA max_page_count=${pages}`);
      }
      return exec.call(this, sql);
    });
    assert.throws(() => new Database(path), /database or disk is full/);
    limited.mock.restore();
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.deepEqual(schemaRows(check), beforeSchema);
    assert.deepEqual(contents(check), before);
    check.close();
    const retry = new Database(path);
    assert.equal(retry.value("PRAGMA user_version"), 2);
    assert.equal(
      retry.value("SELECT data FROM activity WHERE id='unread'"),
      before.activity.find((entry) => entry.id === "unread")!.data,
    );
    retry.close();
  } finally {
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

for (const change of [
  "DROP INDEX activity_owner",
  "CREATE TABLE unknown(value TEXT)",
  "ALTER TABLE users ADD COLUMN unknown TEXT",
  "PRAGMA user_version=0",
  "PRAGMA user_version=3",
]) {
  test(`unknown v1 variants are rejected unchanged: ${change}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-v1-unknown-"));
    const path = join(root, "relay.sqlite");
    try {
      const raw = legacy(path);
      seedEvents(raw, Date.now());
      raw.exec(change);
      const before = contents(raw);
      const beforeSchema = schemaRows(raw);
      const version = raw.prepare("PRAGMA user_version").get()?.user_version;
      raw.close();
      assert.throws(() => new Database(path), { code: "RELAY_SCHEMA_INCOMPATIBLE" });
      const check = new DatabaseSync(path);
      assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, version);
      assert.deepEqual(schemaRows(check), beforeSchema);
      assert.deepEqual(contents(check), before);
      check.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("an arbitrary users SQL comment is not treated as the known legacy fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-v1-comment-"));
  const path = join(root, "relay.sqlite");
  try {
    const raw = legacy(path, "-- Unknown timestamp semantics.");
    seedEvents(raw, Date.now());
    const before = contents(raw);
    const beforeSchema = schemaRows(raw);
    raw.close();
    assert.throws(() => new Database(path), { code: "RELAY_SCHEMA_INCOMPATIBLE" });
    const check = new DatabaseSync(path);
    assert.deepEqual(schemaRows(check), beforeSchema);
    assert.deepEqual(contents(check), before);
    check.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the exact earlier sequence draft only advances its version and preserves existing sequence markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-sequence-v1-"));
  const path = join(root, "relay.sqlite");
  try {
    let db = new Database(path);
    db.run("INSERT INTO users(id,username,password_hash,created) VALUES('owner','owner','synthetic-hash',1)");
    db.run("INSERT INTO activity(id,owner,kind,created,data) VALUES('read','owner','upload',1,'{}')");
    db.run("UPDATE users SET activity_seen=(SELECT sequence FROM activity WHERE id='read')");
    db.run("INSERT INTO activity(id,owner,kind,created,data) VALUES('unread','owner','upload',1,'{}')");
    const before = contents(db.sqlite);
    db.sqlite.exec("PRAGMA user_version=1");
    db.close();
    db = new Database(path);
    assert.equal(db.value("PRAGMA user_version"), 2);
    assert.deepEqual(contents(db.sqlite), before);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
