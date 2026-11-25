// Opening a link records who opened it, for its owner. Doing that must not let anyone fill the
// database, use up a limited link without a browser, or bury the owner's security activity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { api } from "../shared/api.ts";
import { uuidv7 } from "../shared/ids.ts";
import { LINK_SELECT, NEEDS_COOKIES, NEW_VISITORS_PER_NETWORK, VISITS_KEPT } from "../server/modules/links/service.ts";
import { ACTIVITY_LIMIT } from "../server/modules/activity/index.ts";
import { Client, member, openShare, send, start, stop, type Instance } from "./support/harness.ts";

async function setup(instance: Instance, settings: { visitorLimit?: number } = {}) {
  const owner = await member(instance, "sara");
  const { result } = await send(owner, [{ path: "a.txt", data: "alpha" }]);
  const link = await owner.call(api.links.create, {
    body: { id: crypto.randomUUID(), item: result.itemId, days: 7, ...settings },
  });
  return { owner, link };
}

test("opens without a cookie record nothing and use up nothing", async () => {
  const instance = await start();
  try {
    const { owner, link } = await setup(instance, { visitorLimit: 1 });
    const db = instance.ctx.db;
    // A script that keeps no cookies is sent back for one every time, and nothing is written.
    for (let i = 0; i < 20; i++) {
      const res = await instance.app.inject({
        method: "GET",
        url: `/api/s/${link.token}`,
        headers: { host: "relay.test" },
      });
      assert.equal(res.statusCode, 307);
    }
    // Coming back without it, it is refused by a link that counts people…
    const again = await instance.app.inject({
      method: "GET",
      url: `/api/s/${link.token}?again=1`,
      headers: { host: "relay.test" },
    });
    assert.equal(again.statusCode, 403);
    assert.equal(again.json<{ error: string }>().error, NEEDS_COOKIES);
    assert.equal(db.value("SELECT count(*) FROM link_visits"), 0);
    assert.equal(db.value("SELECT count(*) FROM activity WHERE kind = 'link'"), 0);
    // …which still lets in the one person it is for.
    await openShare(new Client(instance), link.token);
    assert.equal((await owner.call(api.links.list))[0].visitors, 1);

    // A link without a limit shows it, uncounted.
    const open = await owner.call(api.links.update, { params: { id: link.id }, body: { visitorLimit: null } });
    const anonymous = await instance.app.inject({
      method: "GET",
      url: `/api/s/${link.token}?again=1`,
      headers: { host: "relay.test" },
    });
    assert.equal(anonymous.statusCode, 200);
    assert.equal(anonymous.json<{ name: string }>().name, "a.txt");
    assert.equal(open.visitors, 1);
    assert.equal(db.value("SELECT count(*) FROM link_visits"), 1);

    // Listing links reads their counts, never their visits.
    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${LINK_SELECT} WHERE l.owner = ?`, 0, "x");
    assert.equal(
      plan.some((row) => row.detail.includes("link_visits")),
      false,
      JSON.stringify(plan),
    );
  } finally {
    await instance.close();
  }
});

test("one network adds only so many people an hour, and a link keeps only so many visits", async () => {
  const instance = await start();
  const root = instance.root;
  let again: Instance | undefined;
  try {
    const { owner, link } = await setup(instance);
    const db = instance.ctx.db;
    const browser = (address: string) => Object.assign(new Client(instance), { address });
    for (let i = 0; i < NEW_VISITORS_PER_NETWORK; i++) await openShare(browser(`203.0.113.${i + 1}`), link.token);
    // Past that, the next person on the network still gets the link, uncounted; elsewhere counts.
    assert.equal((await openShare(browser("203.0.113.200"), link.token)).name, "a.txt");
    await openShare(browser("198.51.100.7"), link.token);
    assert.equal(db.value("SELECT count(*) FROM link_visits"), NEW_VISITORS_PER_NETWORK + 1);
    const [listed] = await owner.call(api.links.list);
    assert.equal(listed.visitors, NEW_VISITORS_PER_NETWORK + 1);
    // All of them share one entry in the owner's feed.
    const opened = (await owner.call(api.activity.list)).entries.filter((e) => e.kind === "link");
    assert.equal(opened.length, 1);
    assert.equal(opened[0].kind === "link" && opened[0].browsers, NEW_VISITORS_PER_NETWORK + 1);

    // Visits long idle make way for new ones; the count keeps everyone.
    const idle = VISITS_KEPT - Number(db.value("SELECT count(*) FROM link_visits"));
    db.tx(() => {
      for (let i = 0; i < idle; i++)
        db.run(
          "INSERT INTO link_visits(id, link, visitor, device, first, last) VALUES(?, ?, ?, 'Firefox on Linux', 1, ?)",
          uuidv7(),
          link.id,
          `idle-${i}`,
          1 + i,
        );
    });
    await openShare(browser("192.0.2.1"), link.token);
    assert.equal(db.value("SELECT count(*) FROM link_visits"), VISITS_KEPT);
    assert.equal(db.value("SELECT count(*) FROM link_visits WHERE visitor = 'idle-0'"), 0, "the longest idle went");
    assert.equal((await owner.call(api.links.list))[0].visitors, VISITS_KEPT + 1);

    // Counts lower than the visits they count (as when the columns are new) are raised at startup.
    db.run("UPDATE links SET visitors = 0, downloads = 0, last_visit = NULL");
    await stop(instance);
    again = await start({}, root);
    assert.deepEqual(
      { ...again.ctx.db.get<{ visitors: number; seen: number }>("SELECT visitors, last_visit > 1 AS seen FROM links") },
      { visitors: VISITS_KEPT, seen: 1 },
    );
  } finally {
    if (again) await again.close();
    else await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("link activity can't push sign-ins out of the feed", async () => {
  const instance = await start();
  try {
    const { owner, link } = await setup(instance);
    const db = instance.ctx.db;
    const owned = db.value<string>("SELECT id FROM users WHERE username = 'sara'")!;
    // Many more link entries than the feed shows, all newer than the sign-in.
    db.tx(() => {
      for (let i = 0; i < ACTIVITY_LIMIT + 20; i++)
        db.run(
          "INSERT INTO activity(id, owner, kind, created, data) VALUES(?, ?, 'link', ?, ?)",
          uuidv7(),
          owned,
          Date.now() + i,
          JSON.stringify({ kind: "link", linkId: link.id, itemId: "x", item: "a.txt", action: "opened", device: "?" }),
        );
    });
    const { entries } = await owner.call(api.activity.list);
    assert.equal(entries.filter((e) => e.kind === "link").length, ACTIVITY_LIMIT);
    assert.ok(
      entries.some((e) => e.kind === "signin"),
      "the sign-in is still there",
    );
    assert.deepEqual(
      entries.map((e) => e.created),
      entries.map((e) => e.created).sort((a, b) => b - a),
      "newest first",
    );
  } finally {
    await instance.close();
  }
});
