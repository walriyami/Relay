import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api, urls } from "../shared/api.ts";
import { ApiError, Client, member, openShare, send, start } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

async function setup() {
  const instance = await start();
  const owner = await member(instance, "sara");
  const { result } = await send(owner, [{ path: "docs/a.txt", data: "alpha", mime: "text/plain" }], {
    text: "hello there",
  });
  const link = await owner.call(api.links.create, { body: { id: crypto.randomUUID(), item: result.itemId, days: 7 } });
  return { instance, owner, itemId: result.itemId, link };
}

test("a link opens the item's current contents; the database holds neither token nor code", async () => {
  const { instance, owner, itemId, link } = await setup();
  try {
    assert.equal(link.itemId, itemId);
    assert.equal(link.available, true);
    assert.match(link.code, /^\d{3}-\d{3}$/);
    assert.equal(link.item?.id, itemId);

    const rows = instance.ctx.db.all<Record<string, unknown>>("SELECT * FROM links");
    const stored = JSON.stringify(rows);
    for (const secret of [link.token, link.code, link.code.replace("-", "")])
      assert.equal(stored.includes(secret), false);
    // Not in the file either (WAL included), so a copied database reveals no working link.
    for (const file of ["relay.sqlite", "relay.sqlite-wal"]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(instance.root, file));
      } catch {
        continue;
      }
      assert.equal(bytes.includes(link.token), false, file);
    }

    const visitor = new Client(instance);
    const share = await openShare(visitor, link.token);
    assert.equal(share.files, 1);
    assert.equal(share.texts, 1);
    assert.equal(share.bytes, 5 + Buffer.byteLength("hello there"));
    assert.equal(share.expires, link.expires);
    const file = share.nodes.find((n) => n.kind === "file")!;
    assert.equal(file.path, "docs/a.txt");
    assert.equal(share.nodes.find((n) => n.kind === "text")?.text, "hello there");
    const content = await visitor.raw({ method: "GET", url: urls.shareContent(link.token, file.id) });
    assert.equal(content.statusCode, 200);
    assert.equal(content.body, "alpha");

    // Creating again with the same id is idempotent; a different item under that id conflicts.
    const again = await owner.call(api.links.create, { body: { id: link.id, item: itemId, days: 7 } });
    assert.equal(again.token, link.token);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM links"), 1);
    const { result: other } = await send(owner, [{ path: "b.txt", data: "beta" }]);
    assert.equal(
      await status(owner.call(api.links.create, { body: { id: link.id, item: other.itemId, days: 7 } })),
      409,
    );

    const listed = await owner.call(api.links.list);
    assert.deepEqual(
      listed.map((l) => l.id),
      [link.id],
    );
    assert.deepEqual(
      (await owner.call(api.items.get, { params: { id: itemId } })).links.map((l) => l.id),
      [link.id],
    );

    // Someone else's item cannot be shared, and someone else's link cannot be touched.
    const stranger = await member(instance, "tom");
    assert.equal(
      await status(stranger.call(api.links.create, { body: { id: crypto.randomUUID(), item: itemId, days: 1 } })),
      404,
    );
    assert.equal(await status(stranger.call(api.links.revoke, { params: { id: link.id } })), 404);
    assert.equal(await status(stranger.call(api.links.update, { params: { id: link.id }, body: { days: 2 } })), 404);
    assert.deepEqual(await stranger.call(api.links.list), []);
    assert.equal(await status(visitor.call(api.links.open, { params: { token: "not-a-real-token" } })), 404);
  } finally {
    await instance.close();
  }
});

test("purging a link retires its pickup code and permanently rejects reuse of its id", async () => {
  const { instance, owner, itemId, link } = await setup();
  try {
    const visitor = new Client(instance);
    await owner.call(api.items.trash, { params: { id: itemId } });
    await owner.call(api.items.remove, { params: { id: itemId } });
    assert.ok(
      instance.ctx.db.value("SELECT retired FROM pickup_codes WHERE kind = 'share' AND target_id = ?", link.id),
      "the purge trigger retires the mapping while preserving its tombstone",
    );

    const { result } = await send(owner, [{ path: "replacement.txt", data: "new content" }]);
    assert.equal(
      await status(owner.call(api.links.create, { body: { id: link.id, item: result.itemId, days: 7 } })),
      409,
    );
    assert.equal(await status(visitor.call(api.pickup.resolve, { body: { code: link.code } })), 404);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM links WHERE id = ?", link.id), 0);
  } finally {
    await instance.close();
  }
});

test("pickup codes resolve to the link; wrong codes are limited per address and globally", async () => {
  const { instance, link } = await setup();
  try {
    const visitor = new Client(instance);
    for (const typed of [link.code, link.code.toLowerCase(), ` ${link.code.replace("-", " ")} `]) {
      const result = await visitor.call(api.pickup.resolve, { body: { code: typed } });
      assert.deepEqual(result, { kind: "share", path: `/s/${link.token}` });
    }
    // A working code can be opened repeatedly without consuming the wrong-code allowance.
    for (let i = 0; i < 12; i++)
      assert.deepEqual(await visitor.call(api.pickup.resolve, { body: { code: link.code } }), {
        kind: "share",
        path: `/s/${link.token}`,
      });
    const wrong = link.code.startsWith("2") ? "3333-3333" : "2222-2222";
    assert.equal(await status(visitor.call(api.pickup.resolve, { body: { code: wrong } })), 404);
    assert.equal(await status(visitor.call(api.pickup.resolve, { body: { code: "short" } })), 404);

    const pickup = (ip: string, code: string) =>
      new Client(instance).raw({
        method: "POST",
        url: api.pickup.resolve.path,
        headers: { "x-forwarded-for": ip },
        payload: { code },
      });
    // Five tries from one address: the fifth starts its one-minute pause.
    const single: number[] = [];
    for (let i = 0; i < 5; i++) single.push((await pickup("10.0.0.1", wrong)).statusCode);
    assert.deepEqual(single, [...Array<number>(4).fill(404), 429]);

    // Ten failures across addresses start the deployment-wide pause; the tenth is refused.
    assert.equal((await pickup("10.0.1.1", wrong)).statusCode, 404);
    assert.equal((await pickup("10.0.1.2", wrong)).statusCode, 404);
    assert.equal((await pickup("10.0.1.3", wrong)).statusCode, 429);
    const clean = await pickup("10.0.1.1", link.code);
    assert.equal(clean.statusCode, 429);
    assert.match(clean.json<{ error: string }>().error, /Too many incorrect codes/);
    const capped = await pickup("10.0.0.1", link.code);
    assert.equal(capped.statusCode, 429);
    assert.match(capped.json<{ error: string }>().error, /Too many incorrect codes/);
  } finally {
    await instance.close();
  }
});

test("live links can be renewed; expiry and revocation are final", async (t) => {
  const { instance, owner, link } = await setup();
  try {
    const visitor = new Client(instance);
    const open = () => status(visitor.call(api.links.open, { params: { token: link.token } }));
    const pickup = () => status(visitor.call(api.pickup.resolve, { body: { code: link.code } }));

    const extended = await owner.call(api.links.update, { params: { id: link.id }, body: { days: 2 } });
    assert.equal(extended.available, true);
    assert.ok(Math.abs(extended.expires! - (Date.now() + 2 * 86_400_000)) < 60_000);
    assert.equal(await open(), 200);

    t.mock.timers.enable({ apis: ["Date"], now: extended.expires! - 1 });
    assert.equal(await open(), 200);
    t.mock.timers.setTime(extended.expires!);
    assert.equal(await open(), 404);
    assert.equal(await pickup(), 404);
    assert.equal((await owner.call(api.links.list))[0].available, false);
    assert.equal(await status(owner.call(api.links.update, { params: { id: link.id }, body: { days: 2 } })), 410);
    assert.equal(
      await status(owner.call(api.links.update, { params: { id: link.id }, body: { note: "Changed" } })),
      410,
    );

    await owner.call(api.links.revoke, { params: { id: link.id } });
    assert.equal(await open(), 404);
    assert.equal(await pickup(), 404);
    const [revoked] = await owner.call(api.links.list);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.available, false);
    assert.equal(await status(owner.call(api.links.update, { params: { id: link.id }, body: { days: 3 } })), 410);
  } finally {
    t.mock.timers.reset();
    await instance.close();
  }
});

test("shares save the earlier item deadline; item renewal alone never extends them", async (t) => {
  const { instance, owner, itemId } = await setup();
  try {
    const now = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now });
    const kept = await owner.call(api.items.update, { params: { id: itemId }, body: { retentionDays: 2 } });
    const shared = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: itemId, days: 7 },
    });
    assert.equal(shared.expires, kept.expires);
    assert.equal(instance.ctx.db.value("SELECT expires FROM links WHERE id = ?", shared.id), kept.expires);
    assert.equal((await openShare(new Client(instance), shared.token)).expires, kept.expires);

    await owner.call(api.items.update, { params: { id: itemId }, body: { retentionDays: 5 } });
    const unchanged = (await owner.call(api.links.list)).find((link) => link.id === shared.id)!;
    assert.equal(unchanged.expires, kept.expires);
    const shorter = await owner.call(api.links.update, { params: { id: shared.id }, body: { days: 1 } });
    assert.equal(shorter.expires, now + 86_400_000);
    const renewed = await owner.call(api.links.update, { params: { id: shared.id }, body: { days: null } });
    assert.equal(renewed.expires, now + 5 * 86_400_000, "explicit renewal stays within the item deadline");

    await owner.call(api.items.update, { params: { id: itemId }, body: { retentionDays: 1 } });
    const tightened = (await owner.call(api.links.list)).find((link) => link.id === shared.id)!;
    assert.equal(tightened.expires, now + 86_400_000, "owner list reports the shortened usable lifetime");
    assert.equal(instance.ctx.db.value("SELECT expires FROM links WHERE id = ?", shared.id), tightened.expires);
    assert.equal((await openShare(new Client(instance), shared.token)).expires, tightened.expires);
  } finally {
    t.mock.timers.reset();
    await instance.close();
  }
});

test("trashing the item stops the link with 410; restoring keeps it revoked", async () => {
  const { instance, owner, itemId, link } = await setup();
  try {
    const visitor = new Client(instance);
    const share = await openShare(visitor, link.token);
    const file = share.nodes.find((n) => n.kind === "file")!;

    await owner.call(api.items.trash, { params: { id: itemId } });
    assert.equal(await status(visitor.call(api.links.open, { params: { token: link.token } })), 410);
    const content = await visitor.raw({ method: "GET", url: urls.shareContent(link.token, file.id) });
    assert.notEqual(content.statusCode, 200);
    assert.equal(
      await status(owner.call(api.links.create, { body: { id: crypto.randomUUID(), item: itemId, days: 1 } })),
      410,
    );

    await owner.call(api.items.restore, { params: { id: itemId } });
    assert.equal(await status(visitor.call(api.links.open, { params: { token: link.token } })), 404);
    const [after] = await owner.call(api.links.list);
    assert.equal(after.revoked, true);
    assert.equal(after.available, false);
    assert.deepEqual(await owner.call(api.links.list).then((l) => l.filter((x) => x.available)), []);

    // A new link works again.
    const fresh = await owner.call(api.links.create, { body: { id: crypto.randomUUID(), item: itemId, days: 1 } });
    assert.equal(await status(visitor.call(api.links.open, { params: { token: fresh.token } })), 200);
  } finally {
    await instance.close();
  }
});

test("a transfer can finish as a link, and a disabled owner's links stop working", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "uma");
    const { result } = await send(owner, [{ path: "c.bin", data: Buffer.alloc(1000, 7) }], {
      destination: { kind: "link", days: 3 },
    });
    assert.ok(result.link);
    assert.equal(result.link.available, true);
    const visitor = new Client(instance);
    await visitor.call(api.links.open, { params: { token: result.link.token } });

    const boss = new Client(instance);
    await boss.signIn("admin", "Test-admin-password-only");
    const { user } = await owner.call(api.session.get);
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
    assert.equal(await status(visitor.call(api.links.open, { params: { token: result.link.token } })), 404);
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: false } });
    assert.equal(await status(visitor.call(api.links.open, { params: { token: result.link.token } })), 200);
    assert.equal(instance.ctx.db.value("SELECT revoked FROM links WHERE id = ?", result.link.id), null);
  } finally {
    await instance.close();
  }
});

test("pickup throttles IPv6 hosts together within a /64", async () => {
  const { instance, link } = await setup();
  try {
    for (let i = 1; i <= 5; i++) {
      const res = await instance.app.inject({
        method: "POST",
        url: api.pickup.resolve.path,
        headers: { host: "relay.test", "x-forwarded-for": `2001:db8:abcd:1234::${i}` },
        payload: { code: "short" },
      });
      assert.equal(res.statusCode, i <= 4 ? 404 : 429);
    }
    const clean = await instance.app.inject({
      method: "POST",
      url: api.pickup.resolve.path,
      headers: { host: "relay.test", "x-forwarded-for": "2001:db8:abcd:1235::1" },
      payload: { code: link.code },
    });
    assert.equal(clean.statusCode, 200);
  } finally {
    await instance.close();
  }
});

test("expired pickup codes count as failed attempts", async () => {
  const { instance, link } = await setup();
  try {
    instance.ctx.db.run("UPDATE links SET expires = ? WHERE id = ?", Date.now() - 1, link.id);
    const visitor = new Client(instance);
    for (let i = 0; i < 5; i++)
      assert.equal(await status(visitor.call(api.pickup.resolve, { body: { code: link.code } })), i < 4 ? 404 : 429);
  } finally {
    await instance.close();
  }
});
