import assert from "node:assert/strict";
import test from "node:test";
import { api, urls } from "../shared/api.ts";
import { admin, openShare, send, start } from "./support/harness.ts";

// Opening one collection must cost what that collection holds, not what the whole library holds.
test("collection views never scan every node or pickup code on the server", async () => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const { result } = await send(owner, [
      { path: "trip/day-1/photo.jpg", data: "one" },
      { path: "trip/day-2/photo.jpg", data: "two" },
    ]);
    const sqlite = instance.ctx.db.sqlite;
    const seen = new Set<string>();
    const prepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = (sql: string) => (seen.add(sql), prepare(sql));
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
      sqlite.prepare = prepare;
    }
    assert.ok(seen.size > 10);
    for (const sql of seen) {
      const plan = sqlite
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null))
        .map((row) => String(row.detail));
      const scans = plan.filter((step) => /^SCAN (nodes|n|pickup_codes)\b/.test(step));
      assert.deepEqual(scans, [], sql.replace(/\s+/g, " "));
    }
  } finally {
    await instance.close();
  }
});
