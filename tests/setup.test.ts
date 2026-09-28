import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, type Input } from "../shared/api.ts";
import { DEFAULTS, NO_LIMITS } from "../shared/model.ts";
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
const chosen = { capacity: 400 * GIB };
const readKey = (root: string) => readFileSync(join(root, "setup.key"), "utf8").trim();
const accountWithKey = (root: string, values = account) => ({ ...values, setupKey: readKey(root) });

test("a first start asks for the administrator, signs them in, then asks for their choices and the storage", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    const visitor = new Client(instance);
    assert.deepEqual(await visitor.call(api.setup.status), { state: "account", keyRequired: false });
    assert.throws(() => readKey(instance.root), "without RELAY_SETUP_KEY there is no key to find");
    assert.equal(await status(visitor.call(api.session.get)), 401);
    assert.equal(await status(visitor.call(api.setup.finish, { body: chosen })), 401);

    const me = await visitor.call(api.setup.account, { body: account });
    assert.equal(me.user.username, "ada", "usernames are stored lowercase");
    assert.equal(me.user.admin, true);
    assert.equal(me.device.name, "Ada’s laptop");
    assert.deepEqual(me.user.limits, NO_LIMITS, "the administrator has no limits");
    const [signIn] = (await visitor.call(api.activity.list)).entries;
    assert.equal(signIn.kind === "signin" && signIn.method, "setup");
    assert.deepEqual(await visitor.call(api.setup.status), { state: "choices", keyRequired: false });

    // Their own choices are saved like any member's; finishing sets the total storage.
    await visitor.call(api.account.update, { body: { retentionDays: 90, trashDays: 14, prefs: { linkDays: null } } });
    await visitor.call(api.setup.finish, { body: chosen });
    assert.deepEqual(await new Client(instance).call(api.setup.status), { state: "done", keyRequired: false });
    assert.equal(await status(visitor.call(api.setup.finish, { body: chosen })), 409, "setup finishes once");

    const overview = await visitor.call(api.admin.overview);
    assert.equal(overview.limits.capacity, chosen.capacity);
    const self = await visitor.call(api.session.get);
    assert.deepEqual(
      [self.user.retentionDays, self.user.trashDays, self.prefs.linkDays],
      [90, 14, null],
      "never-expiring links are the administrator's to choose",
    );

    // A member starts with the built-in values, not the administrator's choices.
    const bea = await member(instance, "bea", visitor);
    const joined = await bea.call(api.session.get);
    assert.deepEqual(joined.user.limits, NO_LIMITS);
    assert.deepEqual(
      [joined.user.retentionDays, joined.user.trashDays, joined.prefs.linkDays],
      [null, DEFAULTS.trashDays, DEFAULTS.linkDays],
    );
  } finally {
    await instance.close();
  }
});

test("with RELAY_SETUP_KEY, creating the administrator needs the one-time key from the data folder", async () => {
  const instance = await start({ setupKey: true }, undefined, { setup: false });
  try {
    const visitor = new Client(instance);
    assert.deepEqual(await visitor.call(api.setup.status), { state: "account", keyRequired: true });
    const keyPath = join(instance.root, "setup.key");
    assert.match(readKey(instance.root), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    assert.equal(
      await status(visitor.call(api.setup.account, { body: account })),
      403,
      "a missing setup key is refused",
    );
    assert.equal(
      await status(visitor.call(api.setup.account, { body: { ...account, setupKey: "wrong-key" } })),
      403,
      "a wrong setup key is refused",
    );
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM users"), 0);

    const me = await visitor.call(api.setup.account, { body: accountWithKey(instance.root) });
    assert.equal(me.user.admin, true);
    assert.throws(() => readFileSync(keyPath), "the key is removed after the first administrator is created");
    assert.deepEqual(await visitor.call(api.setup.status), { state: "choices", keyRequired: false });
  } finally {
    await instance.close();
  }
});

test("a key left from a start with RELAY_SETUP_KEY is removed once it's turned off", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-setup-key-off-"));
  let instance = await start({ setupKey: true }, root, { setup: false });
  try {
    const key = readKey(root);
    await instance.app.close();
    instance = await start({}, root, { setup: false });
    assert.throws(() => readKey(root), "a key that no longer guards anything isn't left lying around");
    const late = new Client(instance);
    assert.deepEqual(await late.call(api.setup.status), { state: "account", keyRequired: false });
    await late.call(api.setup.account, { body: { ...account, setupKey: key } });
  } finally {
    await instance.close();
    await rm(root, { recursive: true, force: true });
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
    assert.deepEqual(await new Client(done).call(api.setup.status), { state: "done", keyRequired: false });
    const late = new Client(done);
    assert.equal(
      await status(late.call(api.setup.account, { body: { ...account, setupKey: "wrong", username: "mallory" } })),
      409,
    );
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

test("setup accepts six-character passwords and rejects shorter ones, unusable usernames and other sites", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    const visitor = new Client(instance);
    assert.equal(await status(visitor.call(api.setup.account, { body: { ...account, password: "short" } })), 400);
    assert.equal(await status(visitor.call(api.setup.account, { body: { ...account, username: "a b" } })), 400);
    const post = (headers: Record<string, string>) =>
      visitor.raw({
        method: "POST",
        url: api.setup.account.path,
        headers,
        payload: account,
      });
    assert.equal((await post({ origin: "https://evil.example" })).statusCode, 403);
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).statusCode, 403);
    assert.deepEqual(
      await visitor.call(api.setup.status),
      { state: "account", keyRequired: false },
      "nothing was created",
    );
    const sixCharacters = "secret";
    const me = await visitor.call(api.setup.account, {
      body: { ...account, password: sixCharacters },
    });
    assert.equal(me.user.username, "ada");
    assert.equal((await new Client(instance).signIn("ada", sixCharacters)).user.id, me.user.id);
  } finally {
    await instance.close();
  }
});

test("without a pinned origin, setup accepts localhost but rejects DNS hosts and scheme mismatches", async () => {
  const instance = await start({ origin: undefined }, undefined, { setup: false });
  try {
    const visitor = new Client(instance);
    const post = (host: string, origin: string) =>
      visitor.raw({
        method: "POST",
        url: api.setup.account.path,
        headers: { host, origin },
        payload: account,
      });
    assert.equal((await post("files.example:8080", "http://files.example:8080")).statusCode, 403);
    assert.equal((await post("localhost", "https://localhost")).statusCode, 403);
    assert.equal((await post("localhost", "http://localhost")).statusCode, 200);
  } finally {
    await instance.close();
  }
});

test("the setup key survives an unfinished restart and disappears after account creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-setup-key-"));
  let instance = await start({ setupKey: true }, root, { setup: false });
  try {
    const before = readFileSync(join(root, "setup.key"), "utf8").trim();
    await instance.app.close();

    instance = await start({ setupKey: true }, root, { setup: false });
    const after = readFileSync(join(root, "setup.key"), "utf8").trim();
    assert.equal(after, before);
    await new Client(instance).call(api.setup.account, { body: accountWithKey(root) });
    assert.throws(() => readFileSync(join(root, "setup.key")));
    await instance.app.close();

    instance = await start({ setupKey: true }, root, { setup: false });
    assert.deepEqual(await new Client(instance).call(api.setup.status), { state: "choices", keyRequired: false });
    assert.throws(() => readFileSync(join(root, "setup.key")), "a restart cannot restore the consumed key");
    const again = new Client(instance);
    await again.signIn(account.username, account.password);
    await again.call(api.setup.finish, { body: chosen });
    assert.deepEqual(await again.call(api.setup.status), { state: "done", keyRequired: false });
  } finally {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the administrator edits one member's name, username and limits", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const bea = await member(instance, "bea", boss);
    await member(instance, "cyd", boss);
    const id = (await bea.call(api.session.get)).user.id;
    const edit = (body: Input<typeof api.admin.updateMember>["body"]) =>
      boss.call(api.admin.updateMember, { params: { id }, body });

    const limits = { storage: 5 * GIB, keepDays: null, linkDays: 30 };
    await edit({ name: "  Bea Quinn ", username: " Beatrice ", limits, expectedLimits: NO_LIMITS });
    const me = await bea.call(api.session.get);
    assert.equal(me.user.name, "Bea Quinn");
    assert.equal(me.user.username, "beatrice");
    assert.deepEqual(me.user.limits, limits);
    assert.equal(me.user.trashDays, DEFAULTS.trashDays, "the member's own settings are theirs");
    assert.equal(me.prefs.autoCopyLink, true, "other preferences stay");

    const listed = (await boss.call(api.admin.overview)).members.find((m) => m.id === id)!;
    assert.deepEqual([listed.name, listed.username, listed.limits], ["Bea Quinn", "beatrice", limits]);

    await edit({ name: null });
    assert.equal((await bea.call(api.session.get)).user.name, null);
    assert.equal(await status(edit({ username: "cyd" })), 409, "usernames stay unique");
    assert.equal(await status(edit({ limits: { ...limits, storage: 0 } })), 400);
    assert.equal(await status(edit({ trashDays: 3 } as never)), 400, "a member's own settings aren't the admin's");
    await bea.signIn("beatrice", "Member-password-only");
    assert.equal(await status(bea.call(api.admin.updateMember, { params: { id }, body: { limits: NO_LIMITS } })), 403);
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
      instance.ctx.db.run(
        "UPDATE items SET trashed = trashed - ?, purge_at = purge_at - ? WHERE id = ?",
        3 * DAY_MS,
        3 * DAY_MS,
        sent.result.itemId,
      );
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
