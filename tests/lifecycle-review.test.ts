import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { NO_LIMITS, type Topic } from "../shared/model.ts";
import { DAY_MS } from "../server/lib/time.ts";
import { admin, Client, member, patchUpload, send, start, type Instance } from "./support/harness.ts";

const pendingTransfer = (client: Client, item?: string) =>
  client.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: client.tab,
      name: null,
      folders: [],
      files: [{ path: "Folder/pending.bin", size: 10, mime: "application/octet-stream" }],
      ...(item ? { item } : {}),
    },
  });

function observeTopics(instance: Instance, ids: string[]) {
  instance.ctx.events.flush();
  return ids.map((id) => {
    const seen: Topic[] = [];
    instance.ctx.events.subscribe(id, (topics) => seen.push(...topics));
    return seen;
  });
}

test("tightening the file-age cap preserves the purge deadline of pending-only Trash", async (t) => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const owner = await member(instance, "pending-trash", boss);
    const { id: ownerId, limits: expectedLimits } = (await owner.call(api.session.get)).user;
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    await owner.call(api.account.update, { body: { trashDays: 2 } });
    const pending = await pendingTransfer(owner);
    await owner.call(api.items.trash, { params: { id: pending.itemId } });

    const deadline = now + 2 * DAY_MS;
    const before = instance.ctx.db.get<{ first_saved_at: number | null; purge_at: number | null }>(
      "SELECT first_saved_at, purge_at FROM items WHERE id = ?",
      pending.itemId,
    )!;
    assert.equal(before.first_saved_at, null);
    assert.equal(before.purge_at, deadline);

    await boss.call(api.admin.updateMember, {
      params: { id: ownerId },
      body: { limits: { ...NO_LIMITS, keepDays: 1 }, expectedLimits },
    });
    const after = instance.ctx.db.get<{
      first_saved_at: number | null;
      purge_at: number | null;
      max_age_days: number | null;
    }>("SELECT first_saved_at, purge_at, max_age_days FROM items WHERE id = ?", pending.itemId)!;
    assert.deepEqual({ ...after }, { first_saved_at: null, purge_at: deadline, max_age_days: 1 });

    await instance.ctx.library.sweep(deadline - 1);
    assert.equal(instance.ctx.db.value("SELECT 1 FROM items WHERE id = ?", pending.itemId), 1);
    await instance.ctx.library.sweep(deadline);
    assert.equal(instance.ctx.db.value("SELECT 1 FROM items WHERE id = ?", pending.itemId), undefined);
  } finally {
    await instance.close();
  }
});

for (const operation of ["single Trash", "bulk Trash", "expiry sweep"] as const) {
  test(`${operation} releases reservations and invalidates every connected member's capacity`, async (t) => {
    const instance = await start();
    try {
      const boss = await admin(instance);
      const owner = await member(instance, "capacity-owner", boss);
      const other = await member(instance, "capacity-observer", boss);
      const ownerId = (await owner.call(api.session.get)).user.id;
      const otherId = (await other.call(api.session.get)).user.id;
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const item = (await send(owner, [], { text: "saved content" })).result.itemId;
      await owner.call(api.items.update, { params: { id: item }, body: { retentionDays: 1 } });
      await pendingTransfer(owner, item);
      assert.equal((await owner.call(api.session.get)).usage.reserved, 10);
      const availableBefore = (await other.call(api.session.get)).usage.available;
      const [ownerTopics, otherTopics] = observeTopics(instance, [ownerId, otherId]);

      if (operation === "single Trash") await owner.call(api.items.trash, { params: { id: item } });
      else if (operation === "bulk Trash")
        await owner.call(api.items.bulk, { body: { ids: [item], operation: "trash" } });
      else {
        now += DAY_MS;
        await instance.ctx.library.sweep(now);
      }

      instance.ctx.events.flush();
      assert.ok(ownerTopics.includes("account"), "the owner must refresh their released reservation");
      assert.ok(otherTopics.includes("account"), "other connected members must refresh shared capacity");
      assert.equal((await owner.call(api.session.get)).usage.reserved, 0);
      assert.equal((await other.call(api.session.get)).usage.available, availableBefore + 10);
      assert.ok(instance.ctx.db.value("SELECT trashed FROM items WHERE id = ?", item));
    } finally {
      await instance.close();
    }
  });
}

test("tightening file age invalidates request byte breakdowns without shortening the request URL", async (t) => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const owner = await member(instance, "request-owner", boss);
    const { id: ownerId, limits: expectedLimits } = (await owner.call(api.session.get)).user;
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Submissions", description: "", days: 5, maxBytes: 100 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    const transfer = await guest.call(api.requests.transfer, {
      params: { token: request.token },
      body: {
        id: crypto.randomUUID(),
        tab: guest.tab,
        folders: [],
        files: [{ path: "submission.bin", size: 7, mime: "application/octet-stream" }],
      },
    });
    const uploaded = await patchUpload(guest, transfer.uploads[0].id, 0, Buffer.alloc(7));
    assert.equal(uploaded.statusCode, 204, uploaded.body);
    await guest.call(api.transfers.complete, {
      params: { id: transfer.id },
      body: { destination: { kind: "save" } },
    });
    await owner.call(api.items.update, { params: { id: transfer.itemId }, body: { retentionDays: null } });
    now += 2 * DAY_MS;
    const before = (await owner.call(api.requests.list))[0];
    assert.deepEqual([before.activeBytes, before.trashBytes, before.pendingBytes, before.usedBytes], [7, 0, 0, 7]);
    const [topics] = observeTopics(instance, [ownerId]);

    const applied = await boss.call(api.admin.updateMember, {
      params: { id: ownerId },
      body: { limits: { ...NO_LIMITS, keepDays: 1 }, expectedLimits },
    });
    instance.ctx.events.flush();
    assert.equal(applied.items, 1);
    assert.equal(applied.requests, 0, "the request URL deadline itself did not change");
    assert.ok(topics.includes("requests"), "the owner must refresh the changed submission breakdown");
    const after = (await owner.call(api.requests.list))[0];
    assert.equal(after.expires, request.expires);
    assert.deepEqual([after.activeBytes, after.trashBytes, after.pendingBytes, after.usedBytes], [0, 7, 0, 7]);
  } finally {
    await instance.close();
  }
});
