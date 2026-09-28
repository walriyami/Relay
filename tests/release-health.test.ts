import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { api } from "../shared/api.ts";
import { start, admin, member, Client, send } from "./support/harness.ts";

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
    assert.deepEqual(health.json(), { ok: true, status: "degraded" });
    // Reupload repairs the same content address, then the health signal recovers.
    await send(user, [{ path: "repaired.txt", data: "correct bytes" }]);
    assert.deepEqual(await anonymous.call(api.health), { ok: true, status: "healthy" });
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
    assert.deepEqual(await client.call(api.health), { ok: true, status: "degraded" });
    usage.flush();
    assert.deepEqual(await client.call(api.health), { ok: true, status: "healthy" });
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
    assert.deepEqual(await boss.call(api.health), { ok: true, status: "degraded" });
    fault.mock.restore();
    await boss.call(api.admin.integrity, { body: {} });
    await setTimeout(0);
    instance.ctx.events.flush();
    assert.equal(notifications, 2);
    assert.equal(instance.ctx.blobs.status().lastError, false);
    assert.equal(instance.ctx.blobs.status().lastResult?.complete, true);
    assert.deepEqual(await boss.call(api.health), { ok: true, status: "healthy" });
    unsubscribe();
  } finally {
    await instance.close();
  }
});
