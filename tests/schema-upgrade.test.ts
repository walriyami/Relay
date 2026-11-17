// Editing server/db/schema.sql in place must never strand existing data: formatting is ignored,
// additions are applied at startup, and anything that could lose data is refused untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../server/db/database.ts";
import { normalizeSql } from "../server/db/schema.ts";

const schema = await readFile(new URL("../server/db/schema.sql", import.meta.url), "utf8");

async function withDatabase(fn: (path: string, root: string) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), "relay-schema-"));
  try {
    const db = new Database(join(root, "relay.sqlite"));
    db.setSetting("kept", "yes");
    db.run("INSERT INTO users(id, username, password_hash, created) VALUES('u1', 'sam', 'x', 1), ('u2', 'jo', 'x', 2)");
    db.close();
    await fn(join(root, "relay.sqlite"), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** schema.sql with one replacement that must apply. */
const edited = (from: string, to: string) => {
  assert.ok(schema.includes(from), from);
  return schema.replace(from, to);
};
const usersEnd = "  created INTEGER NOT NULL\n) STRICT;\n\nCREATE TABLE devices";

test("comments, spacing and letter case in schema.sql don't change the database", async () => {
  await withDatabase((path) => {
    const reformatted = edited(
      usersEnd,
      "  -- When the account was made.\n  created   integer NOT NULL\n)  STRICT ;\n\nCREATE TABLE devices",
    ).replace(
      "CREATE INDEX devices_user ON devices(user_id, seen);",
      "create index devices_user on devices ( user_id,seen ) ;",
    );
    const db = new Database(path, { schema: reformatted });
    assert.deepEqual(db.upgraded, []);
    assert.equal(db.setting("kept"), "yes");
    db.close();
    // And it still opens with the original file.
    new Database(path).close();
  });
});

test("new tables, columns with defaults and new or changed indexes are added, keeping every row", async () => {
  await withDatabase((path) => {
    const next = edited(
      usersEnd,
      "  created INTEGER NOT NULL,\n  nickname TEXT,\n  theme TEXT NOT NULL DEFAULT 'system'\n) STRICT;\n" +
        "CREATE INDEX users_theme ON users(theme);\nCREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;\n\nCREATE TABLE devices",
    )
      // A column can be written anywhere in the table; the database adds it at the end.
      .replace("  display_name TEXT,\n", "  display_name TEXT,\n  pronouns TEXT,\n")
      .replace(
        "CREATE INDEX devices_user ON devices(user_id, seen);",
        "CREATE INDEX devices_user ON devices(user_id, created);",
      );
    const db = new Database(path, { schema: next });
    assert.deepEqual(db.upgraded.sort(), [
      "added column users.nickname",
      "added column users.pronouns",
      "added column users.theme",
      "added index users_theme",
      "added table notes",
      "updated index devices_user",
    ]);
    assert.deepEqual(
      db
        .all("SELECT username, theme, nickname, pronouns FROM users ORDER BY created")
        .map((row) => ({ ...(row as object) })),
      [
        { username: "sam", theme: "system", nickname: null, pronouns: null },
        { username: "jo", theme: "system", nickname: null, pronouns: null },
      ],
    );
    db.run("INSERT INTO notes(id, body) VALUES('n', 'hello')");
    assert.equal(db.value("PRAGMA user_version"), 2);
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    db.close();
    // Opening again with the same schema.sql changes nothing more.
    const again = new Database(path, { schema: next });
    assert.deepEqual(again.upgraded, []);
    again.close();
  });
});

test("an index or trigger removed from schema.sql is removed from the database", async () => {
  await withDatabase((path) => {
    const next = edited("CREATE INDEX devices_user ON devices(user_id, seen);\n", "");
    const db = new Database(path, { schema: next });
    assert.deepEqual(db.upgraded, ["removed index devices_user"]);
    db.close();
  });
});

for (const [name, from, to, table] of [
  ["a removed column", "  display_name TEXT,\n", "", "users"],
  ["a changed column", "  disabled INTEGER NOT NULL DEFAULT 0,", "  disabled TEXT NOT NULL DEFAULT 'no',", "users"],
  [
    "a removed table",
    "CREATE TABLE traffic (\n  hour INTEGER PRIMARY KEY,\n  requests INTEGER NOT NULL DEFAULT 0,\n  failures INTEGER NOT NULL DEFAULT 0\n) STRICT;\n",
    "",
    "traffic",
  ],
  ["a changed table constraint", "  UNIQUE (link, visitor)\n", "  UNIQUE (link)\n", "link_visits"],
] as const)
  test(`${name} is refused with a plain message and the data left exactly as it was`, async () => {
    await withDatabase(async (path) => {
      const before = await readFile(path);
      // Additions in the same edit must not be applied either.
      const next = edited(from, to).replace(
        usersEnd,
        usersEnd.replace("created INTEGER NOT NULL", "created INTEGER NOT NULL, extra TEXT"),
      );
      assert.throws(
        () => new Database(path, { schema: next }),
        (error: Error & { code?: string }) =>
          error.code === "RELAY_SCHEMA_INCOMPATIBLE" &&
          error.message.includes(`"${table}"`) &&
          error.message.includes("Relay has not changed your data"),
      );
      assert.deepEqual(await readFile(path), before);
      const db = new Database(path);
      assert.equal(db.setting("kept"), "yes");
      db.close();
    });
  });

test("an addition SQLite can't make (NOT NULL without a default) is rolled back whole", async () => {
  await withDatabase((path) => {
    const next = edited(
      usersEnd,
      usersEnd.replace("created INTEGER NOT NULL", "created INTEGER NOT NULL, a TEXT, b TEXT NOT NULL"),
    );
    assert.throws(() => new Database(path, { schema: next }));
    const db = new Database(path);
    assert.equal(db.get("SELECT 1 FROM pragma_table_info('users') WHERE name = 'a'"), undefined);
    db.close();
  });
});

test("a database from before shared sign-in gains its tables without a migration step", async () => {
  await withDatabase((path) => {
    const raw = new DatabaseSync(path);
    raw.exec(
      "DROP TABLE external_identities; DROP TABLE external_sessions; DROP TABLE sso_flows; PRAGMA user_version = 1",
    );
    raw.close();
    const db = new Database(path);
    assert.deepEqual(db.upgraded.sort(), [
      "added table external_identities",
      "added table external_sessions",
      "added table sso_flows",
    ]);
    assert.equal(db.value("PRAGMA user_version"), 2);
    assert.equal(db.setting("kept"), "yes");
    db.close();
  });
});

test("normalized SQL keeps quoted text exactly", () => {
  assert.equal(normalizeSql("DEFAULT 'A  b' -- c\n, \"Col\""), "default 'A  b',\"Col\"");
  assert.equal(normalizeSql("x INTEGER CHECK ( x >= 1 )"), normalizeSql("x integer check(x>=1)"));
  assert.notEqual(normalizeSql("DEFAULT 'a'"), normalizeSql("DEFAULT 'A'"));
});

/** Overwrites the middle pages of the database file, as a failing card or interrupted copy would. */
async function damage(path: string) {
  const { size } = await stat(path);
  const file = await open(path, "r+");
  try {
    await file.write(Buffer.alloc(Math.min(5 * 4096, size - 2 * 4096), 0x5a), 0, undefined, 2 * 4096);
  } finally {
    await file.close();
  }
}

test("a damaged database stops startup with a plain explanation and recovery steps", async () => {
  await withDatabase(async (path, root) => {
    // Enough rows that the damaged pages hold data, not just free space.
    const db = new Database(path);
    db.tx(() => {
      for (let i = 0; i < 400; i++) db.setSetting(`filler-${i}`, "x".repeat(200));
    });
    db.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    await damage(path);
    assert.throws(
      () => new Database(path),
      (error: Error & { code?: string }) =>
        error.code === "RELAY_DATABASE_DAMAGED" && /damaged/.test(error.message) && /\.recover/.test(error.message),
    );
    // The server prints the same, without a stack trace, and exits.
    const run = spawnSync(process.execPath, ["server/main.ts"], {
      env: { ...process.env, RELAY_DATA: root, PORT: "0", RELAY_DIRECT: "false" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Relay could not start\./);
    assert.match(run.stderr, /database file \(relay\.sqlite in the data folder\) is damaged/);
    assert.doesNotMatch(run.stderr, /\n\s+at /);
  });
});
