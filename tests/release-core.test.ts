import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../server/db/database.ts";
import { createUsageMeter } from "../server/modules/usage/index.ts";
import { start } from "./support/harness.ts";
import { buildApp } from "../server/app.ts";
import { testConfig } from "./support/config.ts";

test("schema guard accepts fresh/exact current databases, rejects unknown formats and releases rejected locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-schema-"));
  const path = join(root, "db.sqlite");
  try {
    let db = new Database(path);
    db.setSetting("preserved", "value");
    assert.equal(db.value("PRAGMA user_version"), 2);
    db.close();
    db = new Database(path);
    assert.equal(db.setting("preserved"), "value");
    db.close();
    for (const version of [0, 3]) {
      const raw = new DatabaseSync(path);
      raw.exec(`PRAGMA user_version = ${version}`);
      raw.close();
      assert.throws(() => new Database(path), { code: "RELAY_SCHEMA_INCOMPATIBLE" });
      const inspect = new DatabaseSync(path);
      assert.equal(inspect.prepare("SELECT value FROM settings WHERE key='preserved'").get()?.value, "value");
      assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, version);
      inspect.close();
    }
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version=2; DROP TABLE traffic");
    raw.close();
    assert.throws(() => new Database(path), { code: "RELAY_SCHEMA_INCOMPATIBLE" });
    const partial = join(root, "partial.sqlite");
    const old = new DatabaseSync(partial);
    old.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)");
    old.close();
    assert.throws(() => new Database(partial), { code: "RELAY_SCHEMA_INCOMPATIBLE" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage retries the entire failed transaction exactly once, including new samples", async () => {
  const instance = await start();
  const { db, usage } = instance.ctx;
  try {
    usage.flush();
    const user = db.value<string>("SELECT id FROM users LIMIT 1")!;
    const before = db.value<number>("SELECT ifnull(sum(requests),0) FROM traffic")!;
    usage.add(user, { uploaded: 100 });
    usage.request(false);
    const run = db.run.bind(db);
    db.run = function (sql, ...args) {
      if (sql.startsWith("INSERT INTO traffic")) throw new Error("injected disk failure");
      return run.call(this, sql, ...args);
    };
    try {
      assert.throws(() => usage.flush(), /injected disk failure/);
    } finally {
      db.run = run;
    }
    assert.equal(db.value("SELECT ifnull(sum(uploaded),0) FROM usage"), 0, "earlier insert rolled back");
    assert.deepEqual(usage.status(), { pending: 2, failed: true, discarded: 0 });
    usage.add(user, { uploaded: 23 });
    usage.request(true);
    usage.flush();
    usage.flush();
    assert.equal(db.value("SELECT sum(uploaded) FROM usage"), 123);
    assert.equal(db.value("SELECT sum(requests) FROM traffic"), before + 2);
    assert.equal(db.value("SELECT sum(failures) FROM traffic"), 1);
    assert.deepEqual(usage.status(), { pending: 0, failed: false, discarded: 0 });
    usage.add("deleted-user", { uploaded: 999 });
    usage.add(user, { uploaded: 1 });
    usage.flush();
    assert.equal(db.value("SELECT sum(uploaded) FROM usage"), 124, "deleted member cannot poison other rows");
  } finally {
    await instance.close();
  }
});

test("usage outage retries back off, bounds memory, and closes without a surviving timer", async (t) => {
  const instance = await start();
  const meter = createUsageMeter(instance.ctx);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const tx = instance.ctx.db.tx.bind(instance.ctx.db);
  instance.ctx.db.tx = () => {
    attempts++;
    throw new Error("offline");
  };
  try {
    for (let i = 0; i < 16_385; i++) meter.add(`user${i}`, { downloaded: 1 });
    assert.deepEqual(meter.status(), { pending: 16_384, failed: false, discarded: 1 });
    t.mock.timers.tick(5_000);
    assert.equal(attempts, 1);
    t.mock.timers.tick(9_999);
    assert.equal(attempts, 1);
    t.mock.timers.tick(1);
    assert.equal(attempts, 2);
    assert.throws(() => meter.close(), /offline/);
    assert.equal(attempts, 3);
    t.mock.timers.tick(120_000);
    assert.equal(attempts, 3);
  } finally {
    instance.ctx.db.tx = tx;
    t.mock.timers.reset();
    await instance.close();
  }
});

test("shutdown rejects a failed final usage flush while releasing the database", async () => {
  const instance = await start();
  instance.ctx.usage.request(false);
  const tx = instance.ctx.db.tx.bind(instance.ctx.db);
  instance.ctx.db.tx = () => {
    throw new Error("final flush failed");
  };
  try {
    await assert.rejects(instance.app.close(), /final flush failed/);
    const reopened = new Database(join(instance.root, "relay.sqlite"));
    reopened.close();
  } finally {
    instance.ctx.db.tx = tx;
    await rm(instance.root, { recursive: true, force: true });
  }
});

test("failed startup recovery releases its exclusive database lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-startup-failure-"));
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock invokes it with its original receiver.
  const all = Database.prototype.all;
  const injected = t.mock.method(
    Database.prototype,
    "all",
    function (
      this: Database,
      sql: string,
      ...args: Parameters<Database["all"]> extends [string, ...infer A] ? A : never
    ) {
      if (/FROM blobs/i.test(sql)) throw new Error("injected recovery read error");
      return all.call(this, sql, ...args);
    },
  );
  try {
    await assert.rejects(buildApp(testConfig(root)), /injected recovery read error/);
    injected.mock.restore();
    const db = new Database(join(root, "relay.sqlite"));
    db.close();
  } finally {
    injected.mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("app caches only fingerprinted assets and does not substitute HTML for missing bundles", async () => {
  const cwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "relay-assets-"));
  let instance: Awaited<ReturnType<typeof start>> | undefined;
  try {
    await mkdir(join(root, "dist", "assets"), { recursive: true });
    await writeFile(join(root, "dist", "index.html"), "<html>Relay test fixture</html>");
    await writeFile(join(root, "dist", "assets", "index-Abc12345.js"), "export const value=1;");
    await writeFile(join(root, "dist", "favicon.svg"), "<svg/>");
    process.chdir(root);
    instance = await start({ serveClient: true });
    const request = (url: string) => instance!.app.inject({ url, headers: { host: "relay.test" } });
    assert.equal(
      (await request("/assets/index-Abc12345.js")).headers["cache-control"],
      "public, max-age=31536000, immutable",
    );
    for (const url of ["/", "/settings", "/favicon.svg"])
      assert.equal((await request(url)).headers["cache-control"], "no-cache", url);
    assert.equal((await request("/assets/missing.js")).statusCode, 404);
    assert.equal((await request("/api/missing")).statusCode, 404);
    assert.equal((await request("/api/health")).headers["cache-control"], "no-store");
  } finally {
    process.chdir(cwd);
    if (instance) await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});
