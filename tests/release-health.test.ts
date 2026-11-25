import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { api } from "../shared/api.ts";
import { start, admin, member, Client, send } from "./support/harness.ts";
import { build } from "../server/build-info.ts";

/** What /api/health reports about the running code, its commit shortened as Admin shows it; see tests/build-info.test.ts. */
const release = { version: build.version, commit: build.commit?.slice(0, 7) ?? null };

test("admin-only integrity checks expose degradation without taking healthy content offline", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const user = await member(instance, "integrity-member", boss);
    await send(user, [{ path: "file.txt", data: "correct bytes" }]);
    const blob = instance.ctx.db.get<{ sha256: string }>("SELECT sha256 FROM blobs LIMIT 1")!;
    await writeFile(instance.ctx.blobs.path(blob.sha256), "damaged bytes");
    const anonymous = new Client(instance);
    await assert.rejects(anonymous.call(api.admin.integrity, { body: {} }), { status: 401 });
    await assert.rejects(user.call(api.admin.integrity, { body: {} }), { status: 403 });
    const accepted = await boss.call(api.admin.integrity, { body: {} });
    assert.equal(accepted.running, true);
    const deadline = Date.now() + 5000;
    while (instance.ctx.blobs.status().running && Date.now() < deadline) await setTimeout(10);
    assert.equal(instance.ctx.blobs.status().running, false, "background check settles");
    const result = instance.ctx.blobs.status().lastResult!;
    assert.equal(result.corrupt, 1);
    assert.equal(result.complete, true);
    const overview = await boss.call(api.admin.overview);
    assert.equal(overview.integrity.corrupt, 1);
    assert.ok(overview.integrity.lastFullCheck);
    const health = await anonymous.raw({ url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { ok: true, status: "degraded", problems: ["stored-files"], ...release });
    // Reupload repairs the same content address, then the health signal recovers.
    await send(user, [{ path: "repaired.txt", data: "correct bytes" }]);
    assert.deepEqual(await anonymous.call(api.health), { ok: true, status: "healthy", problems: [], ...release });
    const malformed = await boss.raw({ method: "POST", url: "/api/admin/integrity", payload: { after: "invalid" } });
    assert.equal(malformed.statusCode, 400);
  } finally {
    await instance.close();
  }
});

test("health distinguishes retained reporting failure from a healthy database", async () => {
  const instance = await start();
  try {
    const { usage, db } = instance.ctx;
    usage.request(false);
    const tx = db.tx.bind(db);
    db.tx = () => {
      throw new Error("temporary write outage");
    };
    try {
      assert.throws(() => usage.flush());
    } finally {
      db.tx = tx;
    }
    const client = new Client(instance);
    assert.deepEqual(await client.call(api.health), {
      ok: true,
      status: "degraded",
      problems: ["usage-records"],
      ...release,
    });
    usage.flush();
    assert.deepEqual(await client.call(api.health), { ok: true, status: "healthy", problems: [], ...release });
  } finally {
    await instance.close();
  }
});

test("an asynchronous integrity failure settles, notifies the administrator and recovers on retry", async (t) => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    instance.ctx.events.flush();
    let notifications = 0;
    const me = await boss.call(api.session.get);
    const unsubscribe = instance.ctx.events.subscribe(me.user.id, (topics) => {
      if (topics.includes("account")) notifications++;
    });
    const get = instance.ctx.db.get.bind(instance.ctx.db);
    const fault = t.mock.method(instance.ctx.db, "get", (sql: string, ...params: Parameters<typeof get>[1][]) => {
      if (sql.startsWith("SELECT * FROM blobs WHERE sha256 >")) throw new Error("injected scan read failure");
      return get(sql, ...params);
    });
    const response = await boss.raw({ method: "POST", url: "/api/admin/integrity", payload: {} });
    assert.equal(response.statusCode, 202);
    await setTimeout(0);
    instance.ctx.events.flush();
    assert.equal(instance.ctx.blobs.status().running, false);
    assert.equal(instance.ctx.blobs.status().lastError, true);
    assert.equal(notifications, 1);
    assert.deepEqual(await boss.call(api.health), {
      ok: true,
      status: "degraded",
      problems: ["stored-files"],
      ...release,
    });
    fault.mock.restore();
    await boss.call(api.admin.integrity, { body: {} });
    await setTimeout(0);
    instance.ctx.events.flush();
    assert.equal(notifications, 2);
    assert.equal(instance.ctx.blobs.status().lastError, false);
    assert.equal(instance.ctx.blobs.status().lastResult?.complete, true);
    assert.deepEqual(await boss.call(api.health), { ok: true, status: "healthy", problems: [], ...release });
    unsubscribe();
  } finally {
    await instance.close();
  }
});

test("health reports a database that stops taking writes, and fails the check once it is damaged", async (t) => {
  const instance = await start();
  try {
    const { db } = instance.ctx;
    const boss = await admin(instance);
    const user = await member(instance, "health-member", boss);
    const anonymous = new Client(instance);
    assert.deepEqual(await anonymous.call(api.health), { ok: true, status: "healthy", problems: [], ...release });

    // The disk stops taking writes: a change fails, and the health probe keeps finding it so.
    const prepare = (db as unknown as { prepare: (sql: string) => unknown }).prepare.bind(db);
    // The fault hits the statements given; damage is only found where a page of the file is read.
    let fault: { errcode: number; message: string; hits: (sql: string) => boolean } | null = {
      errcode: 13,
      message: "database or disk is full",
      hits: (sql) => sql.startsWith("INSERT INTO settings"),
    };
    t.mock.method(db as unknown as { prepare: (sql: string) => unknown }, "prepare", (sql: string) => {
      if (fault?.hits(sql)) throw Object.assign(new Error(fault.message), { errcode: fault.errcode });
      return prepare(sql);
    });
    assert.throws(() => db.setSetting("anything", "x"), /disk is full/);
    const failing = await anonymous.raw({ url: "/api/health" });
    assert.equal(failing.statusCode, 200, "a restart can't free space, so the check still passes");
    assert.deepEqual(failing.json(), { ok: true, status: "degraded", problems: ["database"], ...release });
    assert.doesNotMatch(failing.body, /disk is full/, "the public route names the problem, not its details");
    // The administrator sees what happened; members don't.
    assert.match((await boss.call(api.admin.overview)).database.failure!.message, /disk is full/);
    await assert.rejects(user.call(api.admin.overview), { status: 403 });

    // Writes work again: the next check finds out on its own.
    fault = null;
    assert.deepEqual(await anonymous.call(api.health), { ok: true, status: "healthy", problems: [], ...release });
    assert.equal((await boss.call(api.admin.overview)).database.failure, null);

    // A damaged database fails the check, which stays failed until Relay restarts and says what to do.
    fault = { errcode: 11, message: "database disk image is malformed", hits: (sql) => sql === "SELECT 1" };
    const damaged = await anonymous.raw({ url: "/api/health" });
    assert.equal(damaged.statusCode, 503, damaged.body);
    assert.deepEqual(damaged.json(), { ok: false, status: "unavailable", problems: ["database"], ...release });
    fault = null;
    assert.equal((await anonymous.raw({ url: "/api/health" })).statusCode, 503);
  } finally {
    instance.ctx.db.storageFailure = null;
    await instance.close();
  }
});
