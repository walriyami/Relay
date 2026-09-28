import { test } from "node:test";
import assert from "node:assert/strict";
import { api, urls } from "../shared/api.ts";
import type { UsageBucket } from "../shared/model.ts";
import { DAY_MS } from "../server/lib/time.ts";
import { periodsOf } from "../server/modules/usage/index.ts";
import { admin, ApiError, Client, member, patchUpload, send, start } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};
const get = (client: Client, url: string) => client.raw({ method: "GET", url });

test("usage samples follow the outer transaction and retain their original values and hour", async (t) => {
  const instance = await start();
  const { db, usage } = instance.ctx;
  try {
    usage.flush();
    const user = db.value<string>("SELECT id FROM users LIMIT 1")!;
    const hourMs = 3_600_000;
    let now = Math.floor(Date.now() / hourMs) * hourMs;
    const hour = now / hourMs;
    const clock = t.mock.method(Date, "now", () => now);
    usage.add(user, { uploaded: 2 });
    assert.throws(() => {
      db.tx(() => {
        usage.add(user, { files: 1 });
        db.tx(() => usage.add(user, { uploaded: 10 }));
        throw new Error("roll back the outer transaction");
      });
    }, /roll back the outer transaction/);
    usage.flush();
    assert.deepEqual(
      { ...db.get<{ uploaded: number; files: number }>("SELECT uploaded, files FROM usage WHERE user_id = ?", user) },
      {
        uploaded: 2,
        files: 0,
      },
    );

    const sample = { uploaded: 10 };
    db.tx(() => {
      usage.add(user, { files: 1 });
      db.tx(() => usage.add(user, sample));
      assert.equal(usage.status().pending, 0, "nested commit waits for the outer transaction");
      sample.uploaded = 999;
      now += hourMs;
    });
    usage.flush();
    usage.flush();
    assert.deepEqual(
      db
        .all<{ hour: number; uploaded: number; files: number }>(
          "SELECT hour, uploaded, files FROM usage WHERE user_id = ?",
          user,
        )
        .map((row) => ({ ...row })),
      [{ hour, uploaded: 12, files: 1 }],
    );
    clock.mock.restore();
  } finally {
    t.mock.restoreAll();
    await instance.close();
  }
});

test("usage discards samples when commit fails and counts a successful retry once", async (t) => {
  const instance = await start();
  const { db, usage } = instance.ctx;
  try {
    usage.flush();
    const user = db.value<string>("SELECT id FROM users LIMIT 1")!;
    usage.add(user, { visitors: 1 });
    const exec = db.sqlite.exec.bind(db.sqlite);
    const failCommit = t.mock.method(db.sqlite, "exec", (sql: string) => {
      if (sql === "COMMIT") throw new Error("injected commit failure");
      return exec(sql);
    });
    const operation = () =>
      db.tx(() => {
        db.setSetting("usage-commit-test", "committed");
        usage.add(user, { visitors: 1 });
      });
    try {
      assert.throws(operation, /injected commit failure/);
    } finally {
      failCommit.mock.restore();
    }
    assert.equal(db.setting("usage-commit-test"), undefined);
    usage.flush();
    assert.equal(db.value("SELECT sum(visitors) FROM usage"), 1, "only the pre-existing sample survives");
    operation();
    usage.flush();
    usage.flush();
    assert.equal(db.setting("usage-commit-test"), "committed");
    assert.equal(db.value("SELECT sum(visitors) FROM usage"), 2);
  } finally {
    t.mock.restoreAll();
    await instance.close();
  }
});

test("a share download rolled back by a storage failure is counted only after a successful retry", async (t) => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const sent = await send(owner, [{ path: "a.txt", data: "hello" }], { destination: { kind: "link", days: 7 } });
    const link = sent.result.link!;
    const item = await owner.call(api.items.get, { params: { id: sent.result.itemId } });
    const node = item.nodes.find((n) => n.kind === "file")!;
    const visitor = new Client(instance);
    await visitor.call(api.links.open, { params: { token: link.token } });
    const db = instance.ctx.db;
    const run = db.run.bind(db);
    const failUpdate = t.mock.method(db, "run", (...[sql, ...args]: Parameters<typeof run>) => {
      if (sql.includes("UPDATE link_visits SET downloads = downloads + 1"))
        throw Object.assign(new Error("injected storage failure"), { code: "SQLITE_FULL" });
      return run(sql, ...args);
    });
    try {
      assert.equal((await get(visitor, urls.shareContent(link.token, node.id))).statusCode, 500);
    } finally {
      failUpdate.mock.restore();
    }
    assert.equal(db.value("SELECT sum(downloads) FROM link_visits WHERE link = ?", link.id), 0);
    const failed = await owner.call(api.usage, { query: { range: "7d", tz: 0 } });
    assert.equal(failed.totals.downloads, 0);
    assert.equal(failed.totals.shared, 0);
    assert.equal((await get(visitor, urls.shareContent(link.token, node.id))).statusCode, 200);
    const retried = await owner.call(api.usage, { query: { range: "7d", tz: 0 } });
    assert.equal(retried.totals.downloads, 1);
    assert.equal(retried.totals.shared, 5);
    assert.equal(db.value("SELECT sum(downloads) FROM link_visits WHERE link = ?", link.id), 1);
  } finally {
    t.mock.restoreAll();
    await instance.close();
  }
});

test("usage counts what each member moved, and whose it was", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const ivy = await member(instance, "ivy", boss);
    const sent = await send(ivy, [{ path: "a.bin", data: Buffer.alloc(600, 1), mime: "image/png" }], {
      destination: { kind: "link", days: 7 },
      text: "hello",
    });
    const item = await ivy.call(api.items.get, { params: { id: sent.result.itemId } });
    const file = item.nodes.find((n) => n.kind === "file")!;

    // Her own download counts as downloaded; a visitor's through her link as shared.
    assert.equal((await get(ivy, urls.nodeContent(file.id))).statusCode, 200);
    const visitor = new Client(instance);
    await visitor.call(api.links.open, { params: { token: sent.result.link!.token } });
    assert.equal((await get(visitor, urls.shareContent(sent.result.link!.token, file.id))).statusCode, 200);
    assert.equal((await get(visitor, urls.shareThumbnail(sent.result.link!.token, file.id))).statusCode >= 200, true);

    // A guest's upload through her request is received, not uploaded.
    const request = await ivy.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Scans", description: "", days: 5, maxBytes: 1000 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    const created = await guest.call(api.requests.transfer, {
      params: { token: request.token },
      body: {
        id: crypto.randomUUID(),
        tab: guest.tab,
        folders: [],
        files: [{ path: "s.pdf", size: 250, mime: "application/pdf" }],
      },
    });
    assert.equal((await patchUpload(guest, created.uploads[0].id, 0, Buffer.alloc(250))).statusCode, 204);
    await guest.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });

    const report = await ivy.call(api.usage, { query: { range: "7d", tz: 0 } });
    assert.equal(report.buckets.length, 7);
    assert.deepEqual(report.totals, {
      uploaded: 600 + 5,
      received: 250,
      downloaded: 600,
      shared: 600,
      files: 2,
      visitors: 1,
      downloads: 1,
    });
    assert.deepEqual(countsOf(report.buckets.at(-1)!), report.totals, "all of it today");
    assert.equal(report.buckets.at(-1)!.stored, 600 + 5 + 250, "what she keeps now");
    assert.deepEqual(report.counts, { items: 2, files: 2, links: 1, requests: 1 });
    assert.equal(report.storage.used, 855);
    assert.deepEqual(
      report.storage.kinds
        .filter((k) => k.bytes > 0)
        .map((k) => [k.kind, k.bytes, k.files])
        .sort(),
      [
        ["documents", 255, 1],
        ["images", 600, 1],
      ].sort(),
    );
    assert.equal(report.largest[0].id, sent.result.itemId);
    assert.equal(report.limit, null);

    // The administrator sees everyone, member by member, and the requests the server answered.
    const all = await boss.call(api.admin.usage, { query: { range: "30d", tz: 0 } });
    assert.equal(all.buckets.length, 30);
    assert.deepEqual(all.totals, report.totals, "only Ivy did anything");
    const row = all.members.find((m) => m.username === "ivy")!;
    assert.deepEqual([row.totals, row.used], [report.totals, 855]);
    assert.ok(all.traffic.at(-1)!.requests > 10);
    assert.equal(all.traffic.at(-1)!.failures, 0);

    // A member sees only their own.
    const own = await boss.call(api.usage, { query: { range: "7d", tz: 0 } });
    assert.equal(own.totals.uploaded, 0);
    assert.equal(await status(ivy.call(api.admin.usage, { query: { range: "7d", tz: 0 } })), 403);
  } finally {
    await instance.close();
  }
});

/** A bucket's counts, without when it starts and what was stored. */
const countsOf = ({ start: _start, stored: _stored, ...counts }: UsageBucket) => counts;

test("periods start at the viewer's midnight and first of the month", () => {
  const now = Date.UTC(2026, 8, 27, 1, 30); // 01:30 UTC, the 27th
  const utc = periodsOf("7d", 0, now);
  assert.equal(utc.starts.length, 7);
  assert.equal(utc.starts.at(-1), Date.UTC(2026, 8, 27));
  assert.equal(utc.end, Date.UTC(2026, 8, 28));
  assert.equal(utc.previous, Date.UTC(2026, 8, 14));

  // Four hours behind UTC it is still the 26th, 21:30.
  const behind = periodsOf("7d", -240, now);
  assert.equal(behind.starts.at(-1), Date.UTC(2026, 8, 26, 4));
  assert.equal(behind.end - behind.starts.at(-1)!, DAY_MS);

  const months = periodsOf("12m", 0, now);
  assert.equal(months.starts.length, 12);
  assert.equal(months.starts[0], Date.UTC(2025, 9, 1));
  assert.equal(months.starts.at(-1), Date.UTC(2026, 8, 1));
  assert.equal(months.end, Date.UTC(2026, 9, 1));
  assert.equal(months.previous, Date.UTC(2024, 9, 1));
});

test("stored bytes are sampled over time and old usage is pruned", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const jo = await member(instance, "joy", boss);
    const { user } = await jo.call(api.session.get);
    await send(jo, [{ path: "a.bin", data: Buffer.alloc(400) }]);
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000);
    // Three days ago she kept 100 bytes; long ago there was traffic nobody needs any more.
    instance.ctx.db.run("INSERT INTO usage(user_id, hour, stored) VALUES(?, ?, ?)", user.id, hour - 72, 100);
    instance.ctx.db.run("INSERT INTO usage(user_id, hour, uploaded) VALUES(?, ?, ?)", user.id, hour - 30_000, 9);
    instance.ctx.usage.sweep(now);

    const report = await jo.call(api.usage, { query: { range: "7d", tz: 0 } });
    const stored = report.buckets.map((b) => b.stored);
    assert.equal(stored.at(-1), 400, "today is what she keeps now");
    assert.equal(stored.at(-4), 100, "three days ago, the sample then");
    assert.equal(stored[0], 0, "nothing before the first sample");
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM usage WHERE hour = ?", hour - 30_000), 0);
    assert.ok(instance.ctx.db.value("SELECT COUNT(*) FROM usage WHERE user_id = ? AND stored = 400", user.id));
  } finally {
    await instance.close();
  }
});
