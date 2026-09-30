import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { admin, start } from "./support/harness.ts";

test("bounded account history orders timestamp ties consistently and marking covers the entire tied timestamp", async (t) => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const { user } = await owner.call(api.session.get);
    const at = Date.now();
    const clock = t.mock.method(Date, "now", () => at);
    for (let i = 0; i < 101; i++)
      instance.ctx.activity.record(user.id, {
        kind: "upload",
        requestId: "fixture-request",
        request: `Documents ${i}`,
        sender: null,
        itemId: "fixture-item",
        files: 1,
        bytes: 1,
        text: false,
      });
    clock.mock.restore();
    const { entries } = await owner.call(api.activity.list);
    assert.equal(entries.length, 100);
    assert.ok(entries.every((entry) => entry.created === at));
    assert.deepEqual(
      entries.map((entry) => entry.id),
      entries
        .map((entry) => entry.id)
        .sort()
        .reverse(),
    );
    await owner.call(api.activity.seen, { body: { until: at } });
    assert.equal((await owner.call(api.activity.list)).seen, at);
    instance.ctx.activity.record(user.id, {
      kind: "upload",
      requestId: "fixture-request",
      request: "Later documents",
      sender: null,
      itemId: "fixture-item",
      files: 1,
      bytes: 1,
      text: false,
    });
    const later = await owner.call(api.activity.list);
    assert.ok(later.entries[0].created > later.seen);
  } finally {
    await instance.close();
  }
});
