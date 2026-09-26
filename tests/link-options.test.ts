import { test } from "node:test";
import assert from "node:assert/strict";
import { api, urls } from "../shared/api.ts";
import type { LinkSettings } from "../shared/model.ts";
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

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1";

async function setup(settings: Partial<LinkSettings> = {}) {
  const instance = await start();
  const owner = await member(instance, "sara");
  const { result } = await send(owner, [{ path: "a.txt", data: "alpha", mime: "text/plain" }], { name: "Photos" });
  const link = await owner.call(api.links.create, {
    body: { id: crypto.randomUUID(), item: result.itemId, days: 7, ...settings },
  });
  return { instance, owner, itemId: result.itemId, link };
}

const download = (client: Client, token: string, node: string, headers: Record<string, string> = {}) =>
  client.raw({ method: "GET", url: urls.shareContent(token, node), headers });

test("the share page says who shared it and shows their note", async () => {
  const { instance, owner, link } = await setup({ note: "From the trip, enjoy" });
  try {
    await owner.call(api.account.update, { body: { name: "Sara Q" } });
    const share = await openShare(new Client(instance), link.token);
    assert.equal(share.from, "Sara Q");
    assert.equal(share.note, "From the trip, enjoy");
    assert.equal(share.name, "Photos");

    await owner.call(api.account.update, { body: { name: "  " } });
    assert.equal((await openShare(new Client(instance), link.token)).from, "sara", "a blank name shows the username");
  } finally {
    await instance.close();
  }
});

test("opens and downloads are traced per person, never for the owner", async () => {
  const { instance, owner, link } = await setup();
  try {
    await openShare(owner, link.token);
    assert.equal((await owner.call(api.links.list))[0].visitors, 0, "the owner's own view is not counted");

    const phone = new Client(instance);
    const opened = await phone.raw({ method: "GET", url: `/api/s/${link.token}`, headers: { "user-agent": IPHONE } });
    assert.equal(opened.statusCode, 200);
    const share = await openShare(phone, link.token);
    const file = share.nodes[0].id;

    // Previews and resumed ranges aren't downloads; a whole attachment is.
    assert.equal(
      (await phone.raw({ method: "GET", url: urls.shareContent(link.token, file, { inline: true }) })).statusCode,
      200,
    );
    assert.equal((await download(phone, link.token, file, { range: "bytes=2-" })).statusCode, 206);
    assert.equal((await download(phone, link.token, file)).statusCode, 200);
    assert.equal((await phone.raw({ method: "GET", url: urls.shareZip(link.token) })).statusCode, 200);

    const laptop = new Client(instance);
    await openShare(laptop, link.token);

    const [listed] = await owner.call(api.links.list);
    assert.equal(listed.visitors, 2);
    assert.equal(listed.downloads, 2);
    assert.ok(listed.lastVisit !== null);
    const visits = await owner.call(api.links.visits, { params: { id: link.id } });
    assert.equal(visits.length, 2);
    const iphone = visits.find((v) => v.device === "Safari on iPhone");
    assert.ok(iphone, JSON.stringify(visits));
    assert.equal(iphone.downloads, 2);

    const { entries } = await owner.call(api.activity.list);
    const events = entries.filter((e) => e.kind === "link").map((e) => e.kind === "link" && e.action);
    assert.deepEqual(events.sort(), ["downloaded", "opened", "opened"], "one entry per person, not per request");

    // Nothing that tells people apart is kept: the visitor key differs from the cookie.
    const cookie = [...phone.cookies.values()].join();
    assert.equal(JSON.stringify(instance.ctx.db.all("SELECT * FROM link_visits")).includes(cookie), false);

    const stranger = await member(instance, "tom");
    assert.equal(await status(stranger.call(api.links.visits, { params: { id: link.id } })), 404);
  } finally {
    await instance.close();
  }
});

test("a password locks the content until entered; changing it locks everyone out again", async () => {
  const { instance, owner, link } = await setup({ password: "open sesame" });
  try {
    assert.equal(link.locked, true);
    assert.equal(JSON.stringify(instance.ctx.db.all("SELECT * FROM links")).includes("open sesame"), false);

    const visitor = new Client(instance);
    const locked = await visitor.call(api.links.open, { params: { token: link.token } });
    assert.deepEqual(locked, { locked: true, from: "sara" }, "nothing about the content shows");
    const node = (await openShare(owner, link.token)).nodes[0].id;
    assert.equal((await download(visitor, link.token, node)).statusCode, 401);
    assert.equal((await visitor.raw({ method: "GET", url: urls.shareZip(link.token) })).statusCode, 401);

    const unlock = (client: Client, password: string) =>
      client.call(api.links.unlock, { params: { token: link.token }, body: { password } });
    assert.equal(await status(unlock(visitor, "wrong")), 403);
    const share = await unlock(visitor, "open sesame");
    assert.equal(share.name, "Photos");
    assert.equal((await openShare(visitor, link.token)).name, "Photos", "the browser stays unlocked");
    assert.equal((await download(visitor, link.token, node)).statusCode, 200);
    assert.equal(await status(unlock(new Client(instance), "open sesame")), 200, "no visit is needed first");

    await owner.call(api.links.update, { params: { id: link.id }, body: { password: "new one" } });
    assert.equal((await visitor.call(api.links.open, { params: { token: link.token } })).locked, true);
    assert.equal((await download(visitor, link.token, node)).statusCode, 401);

    const removed = await owner.call(api.links.update, { params: { id: link.id }, body: { password: null } });
    assert.equal(removed.locked, false);
    assert.equal((await openShare(new Client(instance), link.token)).name, "Photos");

    // Guessing is bounded per link, whichever browser tries: ten wrong tries (one was above).
    await owner.call(api.links.update, { params: { id: link.id }, body: { password: "again" } });
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push(await status(unlock(new Client(instance), `guess ${i}`)));
    assert.deepEqual(codes, [...Array<number>(9).fill(403), 429]);
  } finally {
    await instance.close();
  }
});

test("a link for one person lets in only the first, who can come back", async () => {
  const { instance, owner, link } = await setup({ visitorLimit: 1 });
  try {
    const first = new Client(instance);
    const node = (await openShare(first, link.token)).nodes[0].id;
    const [listed] = await owner.call(api.links.list);
    assert.equal(listed.full, true);
    assert.equal(listed.available, true, "it still works for the person it let in");

    const second = new Client(instance);
    assert.equal(await status(second.call(api.links.open, { params: { token: link.token } })), 410);
    assert.equal((await download(second, link.token, node)).statusCode, 410);
    assert.equal((await openShare(first, link.token)).name, "Photos");
    assert.equal((await download(first, link.token, node)).statusCode, 200);
    await openShare(owner, link.token);

    const raised = await owner.call(api.links.update, { params: { id: link.id }, body: { visitorLimit: 2 } });
    assert.equal(raised.full, false);
    await openShare(second, link.token);
    assert.equal((await owner.call(api.links.list))[0].visitors, 2);

    const open = await owner.call(api.links.update, { params: { id: link.id }, body: { visitorLimit: null } });
    assert.equal(open.visitorLimit, null);
    await openShare(new Client(instance), link.token);
  } finally {
    await instance.close();
  }
});

test("a link can be kept until it is turned off, and a transfer can finish as one", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "sara");
    const { result } = await send(owner, [{ path: "a.txt", data: "alpha" }], {
      destination: { kind: "link", days: null, password: "secret", visitorLimit: 3, note: "hi" },
    });
    const link = result.link!;
    assert.equal(link.expires, null);
    assert.equal(link.locked, true);
    assert.equal(link.visitorLimit, 3);
    assert.equal(link.note, "hi");
    const stored = JSON.stringify(instance.ctx.db.all("SELECT result FROM transfers"));
    assert.equal(stored.includes("secret"), false, "the password is not kept with the transfer");

    const share = await new Client(instance).call(api.links.unlock, {
      params: { token: link.token },
      body: { password: "secret" },
    });
    assert.equal(share.expires, null, "neither the link nor the item ends");

    const kept = await owner.call(api.links.update, { params: { id: link.id }, body: { days: 3 } });
    assert.ok(kept.expires !== null);
    const forever = await owner.call(api.links.update, { params: { id: link.id }, body: { days: null } });
    assert.equal(forever.expires, null);
    assert.deepEqual(
      (await owner.call(api.account.update, { body: { prefs: { linkDays: null } } })).prefs.linkDays,
      null,
    );
  } finally {
    await instance.close();
  }
});

test("members choose the name people see and can change their username", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "sara");
    await member(instance, "tom");
    const named = await client.call(api.account.update, { body: { name: "  Sara Q  " } });
    assert.equal(named.user.name, "Sara Q");
    assert.equal(await status(client.call(api.account.update, { body: { username: "TOM" } })), 409);
    const renamed = await client.call(api.account.update, { body: { username: "  Sara_Q  " } });
    assert.equal(renamed.user.username, "sara_q");
    assert.equal((await client.call(api.session.get)).user.username, "sara_q", "the session carries on");
    assert.equal(await status(new Client(instance).signIn("sara", "Member-password-only")), 401);
    await new Client(instance).signIn("sara_q", "Member-password-only");
    const cleared = await client.call(api.account.update, { body: { name: null } });
    assert.equal(cleared.user.name, null);
  } finally {
    await instance.close();
  }
});
