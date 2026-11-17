import assert from "node:assert/strict";
import test from "node:test";
import { api, urls } from "../shared/api.ts";
import { admin, member, openShare, send, start, type Instance } from "./support/harness.ts";

/** Records every statement Relay runs, including ones already prepared before recording began. */
function record(instance: Instance) {
  const db = instance.ctx.db as unknown as { prepare(sql: string): unknown };
  const prepare = db.prepare.bind(db);
  const seen = new Set<string>();
  db.prepare = (sql: string) => (seen.add(sql), prepare(sql));
  return { seen, stop: () => (db.prepare = prepare) };
}

/** The steps of each statement's plan that read a whole table or index. */
function scans(instance: Instance, seen: Set<string>) {
  const { sqlite } = instance.ctx.db;
  const found: string[] = [];
  for (const sql of seen) {
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null))
      .map((row) => String(row.detail));
    for (const step of plan)
      if (/^SCAN /.test(step) && !/CONSTANT ROW|json_each|subquery|^SCAN (tree|x)\b/.test(step))
        found.push(`${step}  <-  ${sql.replace(/\s+/g, " ")}`);
  }
  return found;
}

// Opening one collection must cost what that collection holds, not what the whole library holds.
test("collection views never scan every node or pickup code on the server", async () => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const { result } = await send(owner, [
      { path: "trip/day-1/photo.jpg", data: "one" },
      { path: "trip/day-2/photo.jpg", data: "two" },
    ]);
    const { seen, stop } = record(instance);
    try {
      await owner.call(api.items.get, { params: { id: result.itemId } });
      const link = await owner.call(api.links.create, {
        body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
      });
      const visitor = await admin(instance);
      await openShare(visitor, link.token);
      for (const url of [urls.itemZip(result.itemId), urls.shareZip(link.token)]) {
        const res = await (url.startsWith("/api/s/") ? visitor : owner).raw({ method: "GET", url });
        assert.equal(res.statusCode, 200, url);
      }
    } finally {
      stop();
    }
    assert.ok(seen.size > 10);
    const found = scans(instance, seen).filter(
      (step) => /^SCAN (nodes|n|pickup_codes)\b/.test(step) && !/USING INDEX nodes_pending\b/.test(step),
    );
    assert.deepEqual(found, []);
  } finally {
    await instance.close();
  }
});

// Pages people keep open refresh themselves, and SQLite answers on the thread that serves every
// transfer: a member's page must cost what that member holds, and an admin page must read every
// file at most where the number it shows needs it.
test("library, usage and admin pages read only what they show", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const user = await member(instance, "planner", boss);
    const { result } = await send(user, [
      { path: "a/b.txt", data: "one" },
      { path: "c.jpg", data: "two", mime: "image/jpeg" },
    ]);
    const other = await send(user, [{ path: "x.txt", data: "three" }]);
    await user.call(api.items.trash, { params: { id: other.result.itemId } });
    const link = await user.call(api.links.create, { body: { id: crypto.randomUUID(), item: result.itemId, days: 7 } });
    const { seen, stop } = record(instance);
    try {
      for (const view of ["library", "trash"] as const)
        for (const sort of ["new", "old", "name", "size"] as const)
          for (const q of ["", "b"])
            await user.call(api.items.list, { query: { view, sort, q, limit: 50, offset: 0 } });
      await user.call(api.items.get, { params: { id: result.itemId } });
      await user.call(api.session.get);
      await user.call(api.links.list);
      await user.call(api.links.visits, { params: { id: link.id } });
      await user.call(api.activity.list);
      for (const direction of ["incoming", "sent"] as const)
        await user.call(api.deliveries.list, { query: { direction } });
      await user.call(api.requests.list);
      for (const range of ["30d", "12m"] as const) await user.call(api.usage, { query: { range, tz: 0 } });
      await user.call(api.devices.list);
      await boss.call(api.admin.overview);
      for (const range of ["7d", "12m"] as const) await boss.call(api.admin.usage, { query: { range, tz: 0 } });
      await boss.call(api.health);
    } finally {
      stop();
    }
    // Whole-table reads that stay: each reads a small table, or a partial index of rows that need
    // attention (damaged copies, unfinished uploads, Trash, open transfers).
    const allowed = [
      /^SCAN (users|u)\b/,
      /^SCAN \w+ USING (COVERING )?INDEX (blobs_degraded|nodes_pending|items_trashed|transfers_open)\b/,
      // The admin overview's totals of stored copies: one pass, however many files share them.
      /^SCAN blobs {2}<- {2}SELECT count\(\*\) AS total, ifnull\(sum\(size\), 0\) AS storedBytes/,
      // The admin's count of items outside Trash, from the narrow owner index.
      /^SCAN items USING COVERING INDEX items_owner {2}<- {2}SELECT count\(\*\) FROM items WHERE trashed IS NULL $/,
      // Per-member totals by file type: a row per member and type.
      /^SCAN stored_types\b/,
      // The admin's counts of open requests and live links; there are few next to files.
      /^SCAN requests\b/,
      /^SCAN l {2}<- {2}SELECT count\(\*\) FROM links l JOIN items i/,
    ];
    const found = scans(instance, seen).filter((step) => !allowed.some((pattern) => pattern.test(step)));
    assert.deepEqual(found, []);
  } finally {
    await instance.close();
  }
});
