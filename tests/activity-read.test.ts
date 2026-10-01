import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { ACTIVITY_DAYS } from "../server/modules/activity/index.ts";
import { admin, start } from "./support/harness.ts";

test("bounded account history orders by insertion and a post-acknowledgement event at the identical time stays unread", async (t) => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const { user } = await owner.call(api.session.get);
    const at = Date.now();
    t.mock.method(Date, "now", () => at);
    const record = (name: string) =>
      instance.ctx.activity.record(user.id, {
        kind: "upload",
        requestId: "fixture-request",
        request: name,
        sender: null,
        itemId: "fixture-item",
        files: 1,
        bytes: 1,
        text: false,
      });
    for (let i = 0; i < 101; i++) record(`Documents ${i}`);
    const { entries } = await owner.call(api.activity.list);
    assert.equal(entries.length, 100);
    assert.ok(entries.every((entry) => entry.created === at));
    assert.deepEqual(
      entries.map((entry) => entry.sequence),
      entries.map((entry) => entry.sequence).sort((a, b) => b - a),
    );
    assert.equal(entries[0].kind === "upload" && entries[0].request, "Documents 100");
    assert.equal(entries[99].kind === "upload" && entries[99].request, "Documents 1");
    const until = entries[0].sequence;
    await owner.call(api.activity.seen, { body: { until } });
    record("After acknowledgement, same millisecond");
    const later = await owner.call(api.activity.list);
    assert.equal(later.seen, until);
    assert.equal(later.entries[0].created, at);
    assert.ok(later.entries[0].sequence > later.seen);
    assert.equal(later.entries.filter((entry) => !entry.self && entry.sequence > later.seen).length, 1);
    await owner.call(api.activity.seen, { body: { until } });
    assert.equal((await owner.call(api.activity.list)).seen, until, "a stale marker cannot read the new event");
  } finally {
    t.mock.restoreAll();
    await instance.close();
  }
});

test("retention deleting every event and a clock rollback cannot reuse acknowledged ordering", async (t) => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const { user } = await owner.call(api.session.get);
    const until = (await owner.call(api.activity.list)).entries[0].sequence;
    await owner.call(api.activity.seen, { body: { until } });
    const at = Date.now();
    await instance.ctx.activity.sweep(at + (ACTIVITY_DAYS + 1) * 86_400_000);
    assert.equal((await owner.call(api.activity.list)).entries.length, 0);
    t.mock.method(Date, "now", () => at - 1000);
    instance.ctx.activity.record(user.id, {
      kind: "upload",
      requestId: "fixture-request",
      request: "After retention",
      sender: null,
      itemId: "fixture-item",
      files: 1,
      bytes: 1,
      text: false,
    });
    const later = await owner.call(api.activity.list);
    assert.equal(later.seen, until);
    assert.equal(later.entries[0].created, at - 1000);
    assert.ok(later.entries[0].sequence > later.seen);
  } finally {
    t.mock.restoreAll();
    await instance.close();
  }
});
