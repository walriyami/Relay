import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { DEFAULTS, NO_LIMITS, type MemberLimits } from "../shared/model.ts";
import { DAY_MS } from "../server/lib/time.ts";
import { admin, ApiError, Client, member, send, start } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

/** Joins through a new invitation with `limits`. */
async function invited(
  instance: Awaited<ReturnType<typeof start>>,
  boss: Client,
  username: string,
  limits: MemberLimits,
) {
  const { token } = await boss.call(api.admin.invite, { body: { limits } });
  const client = new Client(instance);
  await client.call(api.session.join, { body: { token, username, password: "Member-password-only" } });
  return client;
}

/** Days from now until `time`, rounded. */
const daysUntil = (time: number | null) => (time === null ? null : Math.round((time - Date.now()) / DAY_MS));

test("an invitation's limits become the member's, and their settings start within them", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const limits = { storage: 5000, keepDays: 30, linkDays: 3 };
    const ann = await invited(instance, boss, "ann", limits);
    const me = await ann.call(api.session.get);
    assert.deepEqual(me.user.limits, limits);
    assert.equal(me.user.retentionDays, 30, "keeping uploads forever isn't allowed, so the limit is the start");
    assert.equal(me.prefs.linkDays, 3, "the built-in 7 days is longer than allowed");
    assert.equal(me.usage.available, 5000);

    const free = await member(instance, "ben", boss);
    const theirs = await free.call(api.session.get);
    assert.deepEqual(theirs.user.limits, NO_LIMITS, "invitations have no limits unless given some");
    assert.deepEqual([theirs.user.retentionDays, theirs.prefs.linkDays], [null, DEFAULTS.linkDays]);
  } finally {
    await instance.close();
  }
});

test("an invitation can change until it is used", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    await boss.call(api.admin.invite, { body: { note: "Sam" } });
    const [pending] = await boss.call(api.admin.invites);
    assert.deepEqual([pending.note, pending.limits], ["Sam", NO_LIMITS]);

    const limits = { storage: 10_000, keepDays: null, linkDays: 7 };
    await boss.call(api.admin.updateInvite, {
      params: { id: pending.id },
      body: { limits, expectedLimits: NO_LIMITS },
    });
    let [changed] = await boss.call(api.admin.invites);
    assert.deepEqual([changed.note, changed.limits], ["Sam", limits], "what isn't given stays");
    await boss.call(api.admin.updateInvite, { params: { id: pending.id }, body: { note: null } });
    [changed] = await boss.call(api.admin.invites);
    assert.deepEqual([changed.note, changed.limits], [null, limits]);
    assert.equal(
      await status(boss.call(api.admin.updateInvite, { params: { id: pending.id }, body: { quota: 1 } as never })),
      400,
    );

    // Once used, what the member was allowed is theirs to change in Admin, not on the invitation.
    instance.ctx.db.run("UPDATE invites SET used = ? WHERE id = ?", Date.now(), pending.id);
    assert.equal(
      await status(boss.call(api.admin.updateInvite, { params: { id: pending.id }, body: { limits: NO_LIMITS } })),
      404,
    );
    instance.ctx.db.run("UPDATE invites SET used = NULL, expires = ? WHERE id = ?", Date.now() - 1, pending.id);
    assert.equal(
      await status(boss.call(api.admin.updateInvite, { params: { id: pending.id }, body: { limits: NO_LIMITS } })),
      404,
      "expired invitations are gone",
    );
  } finally {
    await instance.close();
  }
});

test("links and uploads last no longer than a member's limits allow", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const cat = await invited(instance, boss, "cat", { storage: null, keepDays: 14, linkDays: 7 });

    // Asking for longer, or for never, gets the limit; asking for less is kept.
    const forever = await send(cat, [{ path: "a.txt", data: "a" }], { destination: { kind: "link", days: null } });
    assert.equal(daysUntil(forever.result.link!.expires), 7);
    const short = await send(cat, [{ path: "b.txt", data: "b" }], { destination: { kind: "link", days: 1 } });
    assert.equal(daysUntil(short.result.link!.expires), 1);
    const link = await cat.call(api.links.update, { params: { id: short.result.link!.id }, body: { days: 90 } });
    assert.equal(daysUntil(link.expires), 7);
    const made = await cat.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: short.result.itemId, days: null },
    });
    assert.equal(daysUntil(made.expires), 7);

    const item = await cat.call(api.items.get, { params: { id: forever.result.itemId } });
    assert.equal(daysUntil(item.expires), 14);
    const kept = await cat.call(api.items.update, { params: { id: item.id }, body: { retentionDays: null } });
    assert.equal(daysUntil(kept.expires), 14);
    await cat.call(api.items.bulk, { body: { operation: "retention", ids: [item.id], retentionDays: 365 } });
    assert.equal(daysUntil((await cat.call(api.items.get, { params: { id: item.id } })).expires), 14);

    // Their own settings are brought within the limits too.
    const { user, prefs } = await cat.call(api.account.update, {
      body: { retentionDays: null, prefs: { linkDays: null } },
    });
    assert.deepEqual([user.retentionDays, prefs.linkDays], [14, 7]);
  } finally {
    await instance.close();
  }
});

test("tightening a member's limits shortens what they have; loosening leaves it", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const dee = await member(instance, "dee", boss);
    const id = (await dee.call(api.session.get)).user.id;
    const open = await send(dee, [{ path: "a.txt", data: "a" }], { destination: { kind: "link", days: null } });
    const brief = await send(dee, [{ path: "b.txt", data: "b" }], { destination: { kind: "link", days: 1 } });
    await dee.call(api.items.update, { params: { id: brief.result.itemId }, body: { retentionDays: 2 } });
    await dee.call(api.account.update, { body: { prefs: { linkDays: null } } });

    const applied = await boss.call(api.admin.updateMember, {
      params: { id },
      body: { limits: { storage: null, keepDays: 30, linkDays: 7 }, expectedLimits: NO_LIMITS },
    });
    assert.deepEqual(applied, { links: 1, items: 2, requests: 0 }, "both items acquire the stricter maximum age");
    const links = await dee.call(api.links.list);
    assert.equal(daysUntil(links.find((l) => l.id === open.result.link!.id)!.expires), 7);
    assert.equal(daysUntil(links.find((l) => l.id === brief.result.link!.id)!.expires), 1);
    assert.equal(daysUntil((await dee.call(api.items.get, { params: { id: open.result.itemId } })).expires), 30);
    assert.equal(daysUntil((await dee.call(api.items.get, { params: { id: brief.result.itemId } })).expires), 2);
    const me = await dee.call(api.session.get);
    assert.deepEqual([me.user.retentionDays, me.prefs.linkDays], [30, 7]);

    const loosened = await boss.call(api.admin.updateMember, {
      params: { id },
      body: { limits: NO_LIMITS, expectedLimits: { storage: null, keepDays: 30, linkDays: 7 } },
    });
    assert.deepEqual(loosened, { links: 0, items: 0, requests: 0 });
    const after = await dee.call(api.links.list);
    assert.equal(daysUntil(after.find((l) => l.id === open.result.link!.id)!.expires), 7, "nothing is lengthened");
    assert.equal((await dee.call(api.session.get)).prefs.linkDays, 7);
  } finally {
    await instance.close();
  }
});

test("a storage limit counts Trash and uploads in progress, and is shared capacity otherwise", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const eve = await invited(instance, boss, "eve", { storage: 1000, keepDays: null, linkDays: null });
    const create = (size: number) =>
      eve.call(api.transfers.create, {
        body: {
          id: crypto.randomUUID(),
          tab: eve.tab,
          name: null,
          folders: [],
          files: [{ path: "f.bin", size, mime: "" }],
        },
      });
    const saved = await send(eve, [{ path: "a.bin", data: Buffer.alloc(600) }]);
    await eve.call(api.items.trash, { params: { id: saved.result.itemId } });
    assert.equal((await eve.call(api.session.get)).usage.available, 400, "Trash still counts");
    assert.equal(await status(create(500)), 413);
    await create(400);
    assert.equal((await eve.call(api.session.get)).usage.available, 0);

    await boss.call(api.admin.settings, { body: { capacity: 5000, expectedCapacity: DEFAULTS.capacityBytes } });
    const fay = await member(instance, "fay", boss);
    assert.equal((await fay.call(api.session.get)).usage.available, 5000 - 1000, "everyone's storage is shared");
  } finally {
    await instance.close();
  }
});
