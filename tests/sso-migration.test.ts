import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../server/db/database.ts";

test("exact v1 migration preserves data and leaves a readable pre-migration recovery database", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-sso-migration-"));
  const path = join(root, "relay.sqlite");
  try {
    const old = new DatabaseSync(path);
    old.exec(await readFile(new URL("../server/db/schema.v1.sql", import.meta.url), "utf8"));
    old.exec("PRAGMA user_version=1");
    old.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run("preserved", "original-setting");
    old.close();
    const db = new Database(path);
    assert.equal(db.setting("preserved"), "original-setting");
    assert.equal(db.value("PRAGMA user_version"), 2);
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    db.close();
    const files = (await readdir(root)).filter((name) => name.includes(".before-sso-"));
    assert.equal(files.length, 1);
    const backup = new DatabaseSync(join(root, files[0]), { readOnly: true });
    assert.equal(backup.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(backup.prepare("SELECT value FROM settings WHERE key='preserved'").get()?.value, "original-setting");
    assert.equal(backup.prepare("SELECT name FROM sqlite_schema WHERE name='external_identities'").get(), undefined);
    backup.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a modified v1 database is rejected without backup, partial migration, or data loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-sso-reject-"));
  const path = join(root, "relay.sqlite");
  try {
    const raw = new DatabaseSync(path);
    raw.exec(await readFile(new URL("../server/db/schema.v1.sql", import.meta.url), "utf8"));
    raw.exec("PRAGMA user_version=1; CREATE TABLE unexpected(value TEXT); INSERT INTO unexpected VALUES('preserved')");
    raw.close();
    assert.throws(() => new Database(path), { code: "RELAY_SCHEMA_INCOMPATIBLE" });
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(check.prepare("SELECT value FROM unexpected").get()?.value, "preserved");
    assert.equal(check.prepare("SELECT name FROM sqlite_schema WHERE name='external_identities'").get(), undefined);
    check.close();
    assert.equal(
      (await readdir(root)).some((name) => name.includes("before-sso")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
