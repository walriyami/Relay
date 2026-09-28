import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { NO_LIMITS, type MemberLimits, type Topic } from "../shared/model.ts";
import { DAY_MS } from "../server/lib/time.ts";
import { applyMemberLimits } from "../server/modules/auth/member-limits.ts";
import { admin, ApiError, Client, member, send, start } from "./support/harness.ts";

const rejected = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;

test("single and bulk renewal cannot revive expired content or old links before maintenance", async (t) => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const saved = await send(boss, [], { text: "expires", destination: { kind: "link", days: null } });
    const id = saved.result.itemId;
    const link = saved.result.link!;
    await boss.call(api.items.update, { params: { id }, body: { retentionDays: 1 } });
    const end = now + DAY_MS;
    now = end - 1;
    await boss.call(api.items.update, { params: { id }, body: { name: "last millisecond" } });
    await boss.call(api.items.bulk, { body: { ids: [id], operation: "retention", retentionDays: 1 } });
    // Re-create the deadline after proving both operations admit live content.
    instance.ctx.db.run("UPDATE items SET expires = ? WHERE id = ?", end, id);
    now = end;
    await assert.rejects(boss.call(api.items.update, { params: { id }, body: { retentionDays: null } }), rejected(410));
    await assert.rejects(
      boss.call(api.items.bulk, { body: { ids: [id], operation: "retention", retentionDays: null } }),
      rejected(409),
    );
    const recipient = new Client(instance);
    await assert.rejects(recipient.call(api.links.open, { params: { token: link.token } }), rejected(410));
    now++;
    await instance.ctx.library.sweep(now);
    await boss.call(api.items.restore, { params: { id } });
    await assert.rejects(recipient.call(api.links.open, { params: { token: link.token } }), rejected(404));
  } finally {
    await instance.close();
  }
});

test("renewing live content never silently extends its stored share deadline", async (t) => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const saved = await send(boss, [], { text: "hello", destination: { kind: "link", days: null } });
    const id = saved.result.itemId;
    await boss.call(api.items.update, { params: { id }, body: { retentionDays: 1 } });
    const originalEnd = now + DAY_MS;
    now += DAY_MS / 2;
    const renewed = await boss.call(api.items.update, { params: { id }, body: { retentionDays: 7 } });
    assert.equal(renewed.expires, now + 7 * DAY_MS);
    const [link] = await boss.call(api.links.list);
    assert.equal(link.expires, originalEnd);
    now = originalEnd;
    await assert.rejects(boss.call(api.links.update, { params: { id: link.id }, body: { days: 7 } }), rejected(410));
  } finally {
    await instance.close();
  }
});

test("tightening total age covers live, pending, and Trash and survives policy loosening", async (t) => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const user = await member(instance, "age", boss);
    const owner = (await user.call(api.session.get)).user.id;
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const original = now;
    const live = (await send(user, [], { text: "live" })).result.itemId;
    const trash = (await send(user, [], { text: "trash" })).result.itemId;
    await user.call(api.items.trash, { params: { id: trash } });
    const pending = await user.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: user.tab,
        name: null,
        folders: [],
        files: [{ path: "pending", size: 1, mime: "" }],
      },
    });
    now += DAY_MS;
    const tighten = { ...NO_LIMITS, keepDays: 3 };
    instance.ctx.db.tx(() => applyMemberLimits(instance.ctx, owner, tighten, now));
    instance.ctx.db.tx(() => applyMemberLimits(instance.ctx, owner, NO_LIMITS, now));
    for (const id of [live, trash]) {
      const row = instance.ctx.db.get<{
        first_saved_at: number;
        expires: number;
        max_age_days: number;
        purge_at: number | null;
      }>("SELECT * FROM items WHERE id = ?", id)!;
      assert.equal(row.first_saved_at, original);
      assert.equal(row.expires, original + 3 * DAY_MS);
      assert.equal(row.max_age_days, 3);
      if (id === trash) assert.equal(row.purge_at, original + 3 * DAY_MS);
    }
    const row = instance.ctx.db.get<{ first_saved_at: null; expires: null; max_age_days: number }>(
      "SELECT i.* FROM items i JOIN transfers t ON t.item = i.id WHERE t.id = ?",
      pending.id,
    )!;
    assert.equal(row.first_saved_at, null);
    assert.equal(row.expires, null);
    assert.equal(row.max_age_days, 3);
    const renewed = await user.call(api.items.update, { params: { id: live }, body: { retentionDays: null } });
    assert.equal(renewed.expires, original + 3 * DAY_MS);
    await user.call(api.items.restore, { params: { id: trash } });
    assert.equal((await user.call(api.items.get, { params: { id: trash } })).expires, original + 3 * DAY_MS);
    now = original + 3 * DAY_MS;
    await assert.rejects(
      user.call(api.items.update, { params: { id: live }, body: { retentionDays: null } }),
      rejected(410),
    );
    await instance.ctx.library.sweep(now);
    assert.equal(instance.ctx.db.value("SELECT 1 FROM items WHERE id = ?", live), undefined);
    assert.equal(instance.ctx.db.value("SELECT 1 FROM items WHERE id = ?", trash), undefined);
  } finally {
    await instance.close();
  }
});

test("Trash deadlines only shorten, and restore ends exactly at the fixed deadline", async (t) => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    await boss.call(api.account.update, { body: { trashDays: 2 } });
    const id = (await send(boss, [], { text: "recoverable" })).result.itemId;
    await boss.call(api.items.trash, { params: { id } });
    const end = now + 2 * DAY_MS;
    await boss.call(api.account.update, { body: { trashDays: 30 } });
    assert.equal((await boss.call(api.items.get, { params: { id } })).purgeAt, end);
    await boss.call(api.account.update, { body: { trashDays: 1 } });
    const earlier = end - DAY_MS;
    assert.equal((await boss.call(api.items.get, { params: { id } })).purgeAt, earlier);
    now = earlier;
    await assert.rejects(boss.call(api.items.restore, { params: { id } }), rejected(410));
    await assert.rejects(boss.call(api.items.bulk, { body: { ids: [id], operation: "restore" } }), rejected(409));
    assert.ok(instance.ctx.db.value("SELECT trashed FROM items WHERE id = ?", id));
  } finally {
    await instance.close();
  }
});

test("maintenance after downtime uses original expiry and grants no extra recovery days", async (t) => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    await boss.call(api.account.update, { body: { trashDays: 1 } });
    const id = (await send(boss, [], { text: "old" })).result.itemId;
    await boss.call(api.items.update, { params: { id }, body: { retentionDays: 1 } });
    const end = now + DAY_MS;
    now = end + DAY_MS - 1;
    await instance.ctx.library.sweep(now);
    const row = await boss.call(api.items.get, { params: { id } });
    assert.equal(row.trashed, end);
    assert.equal(row.purgeAt, end + DAY_MS);
    now++;
    await instance.ctx.library.sweep(now);
    assert.equal(instance.ctx.db.value("SELECT 1 FROM items WHERE id = ?", id), undefined);
    const next = (await send(boss, [], { text: "miss both deadlines" })).result.itemId;
    await boss.call(api.items.update, { params: { id: next }, body: { retentionDays: 1 } });
    now += 3 * DAY_MS;
    await instance.ctx.library.sweep(now);
    assert.equal(instance.ctx.db.value("SELECT 1 FROM items WHERE id = ?", next), undefined);
  } finally {
    await instance.close();
  }
});

test("capacity changes and purge invalidate every connected member's available storage", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const other = await member(instance, "observer", boss);
    const ids = [(await boss.call(api.session.get)).user.id, (await other.call(api.session.get)).user.id];
    const seen = ids.map(() => [] as Topic[]);
    ids.forEach((id, i) => instance.ctx.events.subscribe(id, (topics) => seen[i].push(...topics)));
    instance.ctx.events.flush();
    let capacity = (await boss.call(api.admin.overview)).limits.capacity;
    for (const value of [100, 1000]) {
      seen.forEach((topics) => topics.splice(0));
      await boss.call(api.admin.settings, { body: { capacity: value, expectedCapacity: capacity } });
      capacity = value;
      instance.ctx.events.flush();
      assert.ok(seen.every((topics) => topics.includes("account")));
    }
    const id = (await send(boss, [{ path: "a", data: "bytes" }])).result.itemId;
    await boss.call(api.items.trash, { params: { id } });
    instance.ctx.events.flush();
    seen.forEach((topics) => topics.splice(0));
    await boss.call(api.items.remove, { params: { id } });
    instance.ctx.events.flush();
    assert.ok(seen.every((topics) => topics.includes("account")));
  } finally {
    await instance.close();
  }
});

test("stale policy forms are rejected atomically for member, invitation, and capacity", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const user = await member(instance, "policy", boss);
    const id = (await user.call(api.session.get)).user.id;
    const limits: MemberLimits = { storage: 100, keepDays: 3, linkDays: 1 };
    await boss.call(api.admin.updateMember, { params: { id }, body: { limits, expectedLimits: NO_LIMITS } });
    await assert.rejects(
      boss.call(api.admin.updateMember, {
        params: { id },
        body: { limits: NO_LIMITS, expectedLimits: NO_LIMITS, name: "stale" },
      }),
      rejected(409),
    );
    assert.equal((await user.call(api.session.get)).user.name, null);
    await assert.rejects(
      boss.call(api.admin.updateMember, { params: { id }, body: { limits: NO_LIMITS } }),
      rejected(400),
    );
    await boss.call(api.admin.invite, { body: {} });
    const [invite] = await boss.call(api.admin.invites);
    await boss.call(api.admin.updateInvite, { params: { id: invite.id }, body: { limits, expectedLimits: NO_LIMITS } });
    await assert.rejects(
      boss.call(api.admin.updateInvite, {
        params: { id: invite.id },
        body: { limits: NO_LIMITS, expectedLimits: NO_LIMITS },
      }),
      rejected(409),
    );
    const capacity = (await boss.call(api.admin.overview)).limits.capacity;
    await boss.call(api.admin.settings, { body: { capacity: 100, expectedCapacity: capacity } });
    await assert.rejects(
      boss.call(api.admin.settings, { body: { capacity: 200, expectedCapacity: capacity } }),
      rejected(409),
    );
    await assert.rejects(boss.call(api.admin.settings, { body: { capacity: 200 } }), rejected(400));
    assert.equal((await boss.call(api.admin.overview)).limits.capacity, 100);
  } finally {
    await instance.close();
  }
});
