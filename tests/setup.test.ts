import { test } from "node:test";
import assert from "node:assert/strict";
import { api, type Input } from "../shared/api.ts";
import { DEFAULTS } from "../shared/model.ts";
import { DAY_MS } from "../server/lib/time.ts";
import { admin, ADMIN_PASSWORD, ApiError, Client, member, send, start } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

const GIB = 1024 ** 3;
const account = { username: "Ada", password: "A-long-first-password", deviceName: "Ada’s laptop" };
const chosen = { quota: 20 * GIB, retentionDays: 90, linkDays: 30, trashDays: 14, capacity: 400 * GIB };

test("a first start asks for the administrator, signs them in, then asks what members get", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    const visitor = new Client(instance);
    assert.deepEqual(await visitor.call(api.setup.status), { state: "account" });
    assert.equal(await status(visitor.call(api.session.get)), 401);
    assert.equal(await status(visitor.call(api.setup.finish, { body: chosen })), 401);

    const me = await visitor.call(api.setup.account, { body: account });
    assert.equal(me.user.username, "ada", "usernames are stored lowercase");
    assert.equal(me.user.admin, true);
    assert.equal(me.device.name, "Ada’s laptop");
    assert.equal(me.user.quota, DEFAULTS.quotaBytes, "the built-in values until setup finishes");
    const [signIn] = (await visitor.call(api.activity.list)).entries;
    assert.equal(signIn.kind === "signin" && signIn.method, "setup");
    assert.deepEqual(await visitor.call(api.setup.status), { state: "defaults" });

    await visitor.call(api.setup.finish, { body: chosen });
    assert.deepEqual(await new Client(instance).call(api.setup.status), { state: "done" });
    assert.equal(await status(visitor.call(api.setup.finish, { body: chosen })), 409, "setup finishes once");

    const overview = await visitor.call(api.admin.overview);
    const { capacity, ...values } = chosen;
    assert.deepEqual(overview.defaults, values);
    assert.equal(overview.limits.capacity, capacity);
    const self = (await visitor.call(api.session.get)).user;
    assert.deepEqual(
      [self.quota, self.retentionDays, self.trashDays, (await visitor.call(api.session.get)).prefs.linkDays],
      [values.quota, values.retentionDays, values.trashDays, values.linkDays],
      "the administrator starts with the same as everyone",
    );

    const bea = await member(instance, "bea", visitor);
    const joined = await bea.call(api.session.get);
    assert.equal(joined.user.quota, values.quota);
    assert.equal(joined.user.retentionDays, values.retentionDays);
    assert.equal(joined.user.trashDays, values.trashDays);
    assert.equal(joined.prefs.linkDays, values.linkDays);
  } finally {
    await instance.close();
  }
});

test("once anyone has an account, setup cannot make another", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    await new Client(instance).call(api.setup.account, { body: account });
    const late = new Client(instance);
    assert.equal(
      await status(late.call(api.setup.account, { body: { ...account, username: "mallory" } })),
      409,
      "not while setup is unfinished",
    );
    assert.equal(await status(late.call(api.setup.finish, { body: chosen })), 401);
  } finally {
    await instance.close();
  }

  const done = await start();
  try {
    assert.deepEqual(await new Client(done).call(api.setup.status), { state: "done" });
    const late = new Client(done);
    assert.equal(await status(late.call(api.setup.account, { body: { ...account, username: "mallory" } })), 409);
    assert.equal(done.ctx.db.value("SELECT COUNT(*) FROM users"), 1);
  } finally {
    await done.close();
  }
});

test("two browsers racing through setup make exactly one administrator", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    const results = await Promise.all(
      ["ada", "bea", "cyd"].map((username) =>
        status(new Client(instance).call(api.setup.account, { body: { ...account, username } })),
      ),
    );
    assert.deepEqual(
      results.toSorted((a, b) => a - b),
      [200, 409, 409],
    );
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM users"), 1);
  } finally {
    await instance.close();
  }
});

test("setup refuses weak passwords, unusable usernames and other sites", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    const visitor = new Client(instance);
    assert.equal(await status(visitor.call(api.setup.account, { body: { ...account, password: "short" } })), 400);
    assert.equal(await status(visitor.call(api.setup.account, { body: { ...account, username: "a b" } })), 400);
    const post = (headers: Record<string, string>) =>
      visitor.raw({ method: "POST", url: api.setup.account.path, headers, payload: account });
    assert.equal((await post({ origin: "https://evil.example" })).statusCode, 403);
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).statusCode, 403);
    assert.deepEqual(await visitor.call(api.setup.status), { state: "account" }, "nothing was created");
  } finally {
    await instance.close();
  }
});

test("without a pinned origin, requests must come from the address they were sent to", async () => {
  const instance = await start({ origin: undefined }, undefined, { setup: false });
  try {
    const visitor = new Client(instance);
    const post = (host: string, origin: string) =>
      visitor.raw({ method: "POST", url: api.setup.account.path, headers: { host, origin }, payload: account });
    assert.equal((await post("files.example:8080", "http://elsewhere.example:8080")).statusCode, 403);
    assert.equal((await post("files.example:8080", "http://files.example:9090")).statusCode, 403);
    assert.equal((await post("files.example:8080", "http://files.example:8080")).statusCode, 200);
  } finally {
    await instance.close();
  }
});

test("a restart during setup resumes at what members get", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    await new Client(instance).call(api.setup.account, { body: account });
    const again = new Client(instance);
    await again.signIn(account.username, account.password);
    assert.deepEqual(await again.call(api.setup.status), { state: "defaults" });
    await again.call(api.setup.finish, { body: chosen });
    assert.deepEqual(await again.call(api.setup.status), { state: "done" });
  } finally {
    await instance.close();
  }
});

test("the administrator edits one member's name, username and values", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const bea = await member(instance, "bea", boss);
    await member(instance, "cyd", boss);
    const id = (await bea.call(api.session.get)).user.id;
    const edit = (body: Input<typeof api.admin.updateMember>["body"]) =>
      boss.call(api.admin.updateMember, { params: { id }, body });

    await edit({ name: "  Bea Quinn ", username: " Beatrice ", quota: 5 * GIB, linkDays: null, trashDays: 3 });
    const me = await bea.call(api.session.get);
    assert.equal(me.user.name, "Bea Quinn");
    assert.equal(me.user.username, "beatrice");
    assert.equal(me.user.quota, 5 * GIB);
    assert.equal(me.user.trashDays, 3);
    assert.equal(me.prefs.linkDays, null);
    assert.equal(me.prefs.autoCopyLink, true, "other preferences stay");

    const listed = (await boss.call(api.admin.overview)).members.find((m) => m.id === id)!;
    assert.deepEqual(
      [listed.name, listed.username, listed.quota, listed.linkDays, listed.trashDays],
      ["Bea Quinn", "beatrice", 5 * GIB, null, 3],
    );

    await edit({ name: null });
    assert.equal((await bea.call(api.session.get)).user.name, null);
    assert.equal(await status(edit({ username: "cyd" })), 409, "usernames stay unique");
    assert.equal(await status(edit({ trashDays: 0 })), 400);
    await bea.signIn("beatrice", "Member-password-only");
    assert.equal(await status(bea.call(api.admin.updateMember, { params: { id }, body: { quota: GIB } })), 403);
  } finally {
    await instance.close();
  }
});

test("changing the defaults affects only members who join afterwards", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const early = await member(instance, "early", boss);
    await boss.call(api.admin.settings, { body: { defaults: { quota: 2 * GIB, trashDays: 7 } } });
    const { defaults } = await boss.call(api.admin.overview);
    assert.deepEqual(defaults, { quota: 2 * GIB, retentionDays: null, linkDays: DEFAULTS.linkDays, trashDays: 7 });

    const late = (await (await member(instance, "late", boss)).call(api.session.get)).user;
    assert.deepEqual([late.quota, late.trashDays], [2 * GIB, 7]);
    const kept = (await early.call(api.session.get)).user;
    assert.deepEqual([kept.quota, kept.trashDays], [DEFAULTS.quotaBytes, DEFAULTS.trashDays]);
    const self = (await boss.call(api.session.get)).user;
    assert.equal(self.quota, DEFAULTS.quotaBytes, "the administrator keeps theirs too");

    assert.equal(await status(boss.call(api.admin.settings, { body: { defaults: { quota: 0 } } })), 400);
    assert.equal(await status(boss.call(api.admin.settings, { body: { defaults: { name: "x" } } as never })), 400);
  } finally {
    await instance.close();
  }
});

test("each member's Trash empties after their own number of days", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const brief = await member(instance, "brief", boss);
    const patient = await member(instance, "patient", boss);
    await brief.call(api.account.update, { body: { trashDays: 2 } });
    const trashed = async (client: Client) => {
      const sent = await send(client, [{ path: "a.txt", data: "a" }]);
      await client.call(api.items.trash, { params: { id: sent.result.itemId } });
      instance.ctx.db.run("UPDATE items SET trashed = ? WHERE id = ?", Date.now() - 3 * DAY_MS, sent.result.itemId);
      return sent.result.itemId;
    };
    const gone = await trashed(brief);
    const kept = await trashed(patient);
    await instance.sweep();
    assert.equal(await status(brief.call(api.items.get, { params: { id: gone } })), 404);
    assert.ok((await patient.call(api.items.get, { params: { id: kept } })).trashed, "30 days have not passed");
  } finally {
    await instance.close();
  }
});

test("the harness password signs in to a set-up instance", async () => {
  const instance = await start();
  try {
    const client = new Client(instance);
    assert.equal((await client.signIn("admin", ADMIN_PASSWORD)).user.admin, true);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM devices"), 1, "setup leaves no devices behind");
  } finally {
    await instance.close();
  }
});
