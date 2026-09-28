import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { deviceKind, deviceLabel } from "../shared/devices.ts";
import { DEFAULTS, LIMITS, type DeviceKind, type Me } from "../shared/model.ts";
import { addressKey } from "../server/modules/auth/limits.ts";
import { checkPassword } from "../server/modules/auth/passwords.ts";
import { hashPassword, verifyPassword } from "../server/lib/secrets.ts";
import { admin, ApiError, Client, member, start, type Instance } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

/** Activity shows every group until the member turns one off. */
const ALL_ACTIVITY = { received: true, requests: true, links: true, security: true, members: true };

test("password sign-in and sign-out", async () => {
  const instance = await start();
  try {
    const client = new Client(instance);
    assert.equal(await status(client.call(api.session.get)), 401);
    assert.equal(await status(client.signIn("admin", "Wrong-password-entirely")), 401);
    assert.equal(await status(client.signIn("nobody", "Wrong-password-entirely")), 401);
    const me = await client.signIn("ADMIN", "Test-admin-password-only", "Laptop");
    assert.equal(me.device.name, "Laptop");
    const cookie = instance.ctx.db.get<{ token_hash: string; csrf: string }>("SELECT token_hash, csrf FROM sessions");
    assert.ok(cookie && cookie.token_hash !== client.cookies.get("relay"), "only the token hash is stored");
    await client.call(api.session.signOut);
    assert.equal(client.cookies.has("relay"), false);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM sessions"), 0);
    assert.equal(await status(client.call(api.session.get)), 401);
  } finally {
    await instance.close();
  }
});

test("a disabled member cannot sign in", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const alice = await member(instance, "alice", boss);
    const { user } = await alice.call(api.session.get);
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
    assert.equal(await status(alice.call(api.session.get)), 401);
    assert.equal(await status(new Client(instance).signIn("alice", "Member-password-only")), 403);
    assert.equal(await status(new Client(instance).signIn("alice", "Not-her-password-at-all")), 401);
  } finally {
    await instance.close();
  }
});

test("password sign-in is rate limited per address", async () => {
  const instance = await start();
  try {
    const client = new Client(instance);
    const results: number[] = [];
    for (let i = 0; i < 11; i++) results.push(await status(client.signIn("admin", "Wrong-password-entirely")));
    assert.deepEqual(results.slice(0, 10), Array(10).fill(401));
    assert.equal(results[10], 429);
  } finally {
    await instance.close();
  }
});

test("IPv6 address buckets use /64 and normalize mapped IPv4", () => {
  assert.equal(addressKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(addressKey("2001:0DB8:0001:0002::abcd"), "2001:db8:1:2::/64");
  assert.notEqual(addressKey("2001:db8:1:3::1"), addressKey("2001:db8:1:2::1"));
  assert.equal(addressKey("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(addressKey("0:0:0:0:0:FFFF:C000:0201"), "192.0.2.1");
});

test("failed password checks are capped per username, including concurrent attempts", async () => {
  const instance = await start();
  try {
    const user = await member(instance, "finn");
    const hash = instance.ctx.db.value<string>("SELECT password_hash FROM users WHERE username = ?", "finn")!;
    const attempts = await Promise.allSettled(
      Array.from({ length: 21 }, () => checkPassword(instance.ctx, "finn", "Wrong-password-entirely", hash)),
    );
    assert.equal(attempts.filter((result) => result.status === "fulfilled" && !result.value).length, 20);
    const limited = attempts.find((result) => result.status === "rejected");
    assert.equal((limited?.reason as { status?: number } | undefined)?.status, 429);
    assert.equal(await status(user.call(api.session.get)), 200);
  } finally {
    await instance.close();
  }
});

test("password derivations share a bounded process-wide queue", async () => {
  const encoded = await hashPassword("Queue-test-password-only");
  const attempts = await Promise.allSettled(
    Array.from({ length: 35 }, (_, index) =>
      index % 2 ? hashPassword("Queue-test-password-only") : verifyPassword("Queue-test-password-only", encoded),
    ),
  );
  const accepted = attempts.filter((result) => result.status === "fulfilled");
  const rejected = attempts.filter((result) => result.status === "rejected");
  assert.equal(accepted.length, 34, "two derivations run while up to 32 wait");
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0].reason as { status?: number }).status, 429);
  assert.ok(accepted.every((result) => result.status === "fulfilled" && result.value !== false));
});

test("joining consumes the invitation exactly once", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const { token, expires } = await boss.call(api.admin.invite);
    assert.ok(expires > Date.now());
    const join = (username: string) =>
      new Client(instance).call(api.session.join, {
        body: { token, username, password: "Member-password-only", deviceName: "Phone" },
      });
    const me = await join("bob");
    assert.equal(me.user.username, "bob");
    assert.equal(me.user.admin, false);
    assert.equal(await status(join("carol")), 410);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM users"), 2);

    const second = await boss.call(api.admin.invite);
    const taken = new Client(instance).call(api.session.join, {
      body: { token: second.token, username: "bob", password: "Member-password-only" },
    });
    assert.equal(await status(taken), 409);
    // The failed attempt rolled back, so the invitation still works.
    await new Client(instance).call(api.session.join, {
      body: { token: second.token, username: "carol", password: "Member-password-only" },
    });

    const expired = await boss.call(api.admin.invite);
    instance.ctx.db.run("UPDATE invites SET expires = ? WHERE used IS NULL", Date.now() - 1);
    const late = new Client(instance).call(api.session.join, {
      body: { token: expired.token, username: "dave", password: "Member-password-only" },
    });
    assert.equal(await status(late), 410);
  } finally {
    await instance.close();
  }
});

test("an invitation can be checked before joining, revealing only whether it works", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const { token, expires } = await boss.call(api.admin.invite);
    const visitor = new Client(instance);
    const check = (value: string) => visitor.call(api.session.invitation, { params: { token: value } });
    assert.deepEqual(await check(token), { expires, invitedBy: "admin" });

    // Unknown, used and expired invitations all look the same.
    const unknown = await check("garbage-token").catch((error: ApiError) => error);
    assert.equal((unknown as ApiError).status, 410);
    await visitor.call(api.session.join, { body: { token, username: "gil", password: "Member-password-only" } });
    assert.equal(await status(new Client(instance).call(api.session.invitation, { params: { token } })), 410);
    const expiring = await boss.call(api.admin.invite);
    instance.ctx.db.run("UPDATE invites SET expires = ? WHERE used IS NULL", Date.now() - 1);
    const expired = await check(expiring.token).catch((error: ApiError) => error);
    assert.equal((expired as ApiError).status, 410);
    assert.equal((expired as ApiError).message, (unknown as ApiError).message);
  } finally {
    await instance.close();
  }
});

test("invitation checks are rate limited per address", async () => {
  const instance = await start();
  try {
    const client = new Client(instance);
    const results: number[] = [];
    for (let i = 0; i < 21; i++)
      results.push(await status(client.call(api.session.invitation, { params: { token: `guess-${i}` } })));
    assert.deepEqual(results.slice(0, 20), Array(20).fill(410));
    assert.equal(results[20], 429);
  } finally {
    await instance.close();
  }
});

test("changing the password signs out every other session", async () => {
  const instance = await start();
  try {
    const here = await member(instance, "erin");
    const { user } = await here.call(api.session.get);
    instance.ctx.db.run(
      "INSERT INTO passkeys(id, user_id, public_key, counter, transports, name, created) VALUES(?, ?, ?, ?, ?, ?, ?)",
      "erin-test-passkey",
      user.id,
      Buffer.from([1, 2, 3]),
      0,
      "[]",
      "Test key",
      Date.now(),
    );
    const there = new Client(instance);
    await there.signIn("erin", "Member-password-only", "Other");
    const outstandingCode = await here.call(api.loginCodes.create);
    const wrong = here.call(api.account.password, {
      body: { current: "Not-the-current-one", password: "Brand-new-password" },
    });
    assert.equal(await status(wrong), 403);
    await here.call(api.account.password, {
      body: { current: "Member-password-only", password: "Brand-new-password" },
    });
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM passkeys WHERE user_id = ?", user.id), 1);
    await here.call(api.session.get);
    assert.equal(await status(there.call(api.session.get)), 401);
    assert.equal(
      await status(
        new Client(instance).call(api.session.code, {
          body: { code: outstandingCode.code, deviceName: "Stale code" },
        }),
      ),
      410,
      "changing a password retires sign-in codes from the surviving session too",
    );
    assert.equal(await status(new Client(instance).signIn("erin", "Member-password-only")), 401);
    await new Client(instance).signIn("erin", "Brand-new-password");
  } finally {
    await instance.close();
  }
});

test("account settings and preferences", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "fran");
    const updated = await client.call(api.account.update, { body: { retentionDays: 30, prefs: { linkDays: 3 } } });
    assert.equal(updated.user.retentionDays, 30);
    assert.deepEqual(updated.prefs, { linkDays: 3, autoCopyLink: true, activity: ALL_ACTIVITY });
    const again = await client.call(api.account.update, { body: { prefs: { autoCopyLink: false } } });
    assert.deepEqual(again.prefs, { linkDays: 3, autoCopyLink: false, activity: ALL_ACTIVITY });
    const me = await client.call(api.session.get);
    assert.deepEqual(me.prefs, { linkDays: 3, autoCopyLink: false, activity: ALL_ACTIVITY });
    assert.equal(me.user.retentionDays, 30);
  } finally {
    await instance.close();
  }
});

test("unsafe requests need the CSRF token and our own origin", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "gina");
    const post = (headers: Record<string, string>) =>
      client.raw({ method: "POST", url: api.devices.signOutOthers.path, headers });
    assert.equal((await post({ "x-relay-csrf": "wrong" })).statusCode, 403);
    const csrf = client.csrf;
    client.csrf = "";
    assert.equal((await post({})).statusCode, 403);
    client.csrf = csrf;
    assert.equal((await post({ origin: "https://evil.example" })).statusCode, 403);
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).statusCode, 403);
    assert.equal((await post({ origin: "http://relay.test", "sec-fetch-site": "same-origin" })).statusCode, 200);
    // Sign-in endpoints skip the token but still refuse other origins.
    const signIn = await new Client(instance).raw({
      method: "POST",
      url: api.session.password.path,
      headers: { origin: "https://evil.example" },
      payload: { username: "gina", password: "Member-password-only" },
    });
    assert.equal(signIn.statusCode, 403);
  } finally {
    await instance.close();
  }
});

async function codeFlow(instance: Instance) {
  const phone = await member(instance, "hana");
  const created = await phone.call(api.loginCodes.create);
  assert.match(created.code, /^\d{3}-\d{3}$/);
  assert.equal(created.expiresIn, DEFAULTS.loginCodeMinutes * 60_000);
  return { phone, created };
}

test("a new browser named like a signed-in one is numbered, and a name frees up once signed out", async () => {
  const instance = await start();
  try {
    const first = await admin(instance);
    const second = await admin(instance);
    assert.equal((await first.call(api.session.get)).device.name, "Test browser");
    assert.equal((await second.call(api.session.get)).device.name, "Test browser 2");
    await second.call(api.session.signOut);
    const third = await admin(instance);
    assert.equal((await third.call(api.session.get)).device.name, "Test browser 2");
  } finally {
    await instance.close();
  }
});

test("login codes sign in a new browser once", async () => {
  const instance = await start();
  try {
    const { phone, created } = await codeFlow(instance);
    assert.deepEqual(await new Client(instance).call(api.pickup.resolve, { body: { code: created.code } }), {
      kind: "device",
      path: `/?device=${encodeURIComponent(created.token)}`,
    });
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM login_codes WHERE code_hash = ?", created.code), 0);
    const listed = await phone.call(api.loginCodes.list);
    assert.deepEqual(
      listed.map((c) => ({ id: c.id, deviceName: c.deviceName })),
      [{ id: created.id, deviceName: "hana browser" }],
    );

    const laptop = new Client(instance);
    const typed = created.code.toLowerCase().replace("-", " ");
    const me = await laptop.call(api.session.code, { body: { code: typed, deviceName: "Laptop" } });
    assert.equal(me.user.username, "hana");
    assert.equal(me.device.name, "Laptop");
    await laptop.call(api.session.get);
    assert.deepEqual(await phone.call(api.loginCodes.list), []);

    const reuse = new Client(instance).call(api.session.code, { body: { code: created.code, deviceName: "Again" } });
    assert.equal(await status(reuse), 410);
    assert.equal(await status(new Client(instance).call(api.pickup.resolve, { body: { code: created.code } })), 410);
    const junk = new Client(instance).call(api.session.code, { body: { code: "not a code", deviceName: "Junk" } });
    assert.equal(await status(junk), 410);
  } finally {
    await instance.close();
  }
});

test("a login code status changes only when that code signs in a device", async () => {
  const instance = await start();
  try {
    const { phone, created } = await codeFlow(instance);
    const statusOf = (client: Client) => client.call(api.loginCodes.status, { params: { id: created.id } });
    assert.deepEqual(await statusOf(phone), { state: "pending" });

    // A new device signed in to the same account with its password; it did not redeem this code.
    const unrelated = new Client(instance);
    await unrelated.signIn("hana", "Member-password-only", "Unrelated sign-in");
    assert.deepEqual(await statusOf(phone), { state: "pending" });

    // Another member cannot learn this code's status.
    const stranger = await member(instance, "irma");
    assert.deepEqual(await statusOf(stranger), { state: "gone" });

    const approved = new Client(instance);
    await approved.call(api.session.code, { body: { code: created.code, deviceName: "Approved tablet" } });
    assert.deepEqual(await statusOf(phone), { state: "used", deviceName: "Approved tablet" });

    // Sweeping before expiry keeps the used result available to the issuing device.
    await instance.sweep();
    assert.deepEqual(await statusOf(phone), { state: "used", deviceName: "Approved tablet" });
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM login_codes WHERE id = ?", created.id), 1);

    instance.ctx.db.run("UPDATE login_codes SET expires = ? WHERE id = ?", Date.now() - 1, created.id);
    assert.deepEqual(await statusOf(phone), { state: "gone" });
    await instance.sweep();
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM login_codes WHERE id = ?", created.id), 0);
  } finally {
    await instance.close();
  }
});

test("login codes expire, are replaced, revoked, and die with their session", async () => {
  const instance = await start();
  try {
    const { phone, created } = await codeFlow(instance);
    const redeem = (code: string) => new Client(instance).call(api.session.code, { body: { code, deviceName: "New" } });

    instance.ctx.db.run("UPDATE login_codes SET expires = ? WHERE id = ?", Date.now() - 1, created.id);
    assert.equal(await status(redeem(created.code)), 410);

    const first = await phone.call(api.loginCodes.create);
    const second = await phone.call(api.loginCodes.create);
    assert.equal(await status(redeem(first.code)), 410, "a new code retires the previous one");
    assert.deepEqual(
      (await phone.call(api.loginCodes.list)).map((c) => c.id),
      [second.id],
    );

    await phone.call(api.loginCodes.revoke, { params: { id: second.id } });
    assert.equal(await status(redeem(second.code)), 410);
    const other = await member(instance, "ivan");
    const third = await phone.call(api.loginCodes.create);
    assert.equal(await status(other.call(api.loginCodes.revoke, { params: { id: third.id } })), 404);

    await phone.call(api.session.signOut);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM login_codes WHERE id = ?", third.id), 0);
    assert.equal(await status(redeem(third.code)), 410);
  } finally {
    await instance.close();
  }
});

test("login code creation is rate limited", async () => {
  const instance = await start();
  try {
    const { phone } = await codeFlow(instance);
    const results: number[] = [];
    for (let i = 0; i < 10; i++) results.push(await status(phone.call(api.loginCodes.create)));
    assert.deepEqual(results, [...Array<number>(9).fill(200), 429]);
    // Said in words people can act on, with how long to wait.
    await assert.rejects(phone.call(api.loginCodes.create), (error: Error) =>
      /Too many tries\. Wait (a second|\d+ seconds) and try again\.$/.test(error.message),
    );
    // The limit is per account, so someone else on the same address can still add a device.
    const other = await member(instance, "iris");
    assert.equal(await status(other.call(api.loginCodes.create)), 200);
  } finally {
    await instance.close();
  }
});

const UA = {
  iPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iPad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  pixel:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  galaxyTab:
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  firefoxAndroid: "Mozilla/5.0 (Android 15; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
  edgeAndroid:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0",
  chromeOS:
    "Mozilla/5.0 (X11; CrOS x86_64 16093.59.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
};

test("a device is a phone, tablet or computer by its browser", () => {
  assert.equal(deviceKind(UA.iPhone), "phone");
  assert.equal(deviceKind(UA.pixel), "phone");
  assert.equal(deviceKind(UA.firefoxAndroid), "phone");
  assert.equal(deviceKind(UA.iPad), "tablet");
  assert.equal(deviceKind(UA.galaxyTab), "tablet");
  assert.equal(deviceKind(UA.mac), "computer");
  assert.equal(deviceKind(UA.windows), "computer");
  assert.equal(deviceKind(""), "computer");
  assert.equal(deviceLabel(UA.edgeAndroid), "Edge on Android");
  assert.equal(deviceLabel(UA.chromeOS), "Chrome on ChromeOS");
  // iPadOS Safari sends a Mac user agent; its touch screen is what tells it apart.
  assert.equal(deviceKind(UA.mac, 5), "tablet");
  assert.equal(deviceLabel(UA.mac, 5), "Safari on iPad");
  assert.equal(deviceKind(UA.mac, 0), "computer");
  assert.equal(deviceLabel(UA.mac, 0), "Safari on Mac");
  assert.equal(deviceKind(UA.windows, 10), "computer");
});

/** Signs in as a browser with this user agent, and returns its device. */
async function signInAs(client: Client, userAgent: string, deviceName: string, kind?: DeviceKind) {
  const res = await client.raw({
    method: "POST",
    url: api.session.password.path,
    headers: { "user-agent": userAgent },
    payload: { username: "jack", password: "Member-password-only", deviceName, deviceKind: kind },
  });
  assert.equal(res.statusCode, 200);
  return res.json<Me>().device;
}

test("a signing-in browser's own kind wins over its user agent, which remains the fallback", async () => {
  const instance = await start();
  try {
    await member(instance, "jack");
    assert.equal((await signInAs(new Client(instance), UA.mac, "Safari on iPad", "tablet")).kind, "tablet");
    assert.equal((await signInAs(new Client(instance), UA.iPhone, "Safari on iPhone")).kind, "phone");
    const res = await new Client(instance).raw({
      method: "POST",
      url: api.session.password.path,
      headers: { "user-agent": UA.mac },
      payload: { username: "jack", password: "Member-password-only", deviceName: "Odd", deviceKind: "watch" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await instance.close();
  }
});

test("automatic device names stay within the configured name limit", async () => {
  const instance = await start();
  try {
    await member(instance, "jack");
    const longName = "x".repeat(LIMITS.nameLength);
    const first = await signInAs(new Client(instance), UA.mac, longName);
    const second = await signInAs(new Client(instance), UA.mac, longName);
    assert.equal(first.name, longName);
    assert.equal(second.name.length, LIMITS.nameLength);
    assert.ok(second.name.endsWith(" 2"));
  } finally {
    await instance.close();
  }
});

test("devices can be listed, renamed and signed out", async () => {
  const instance = await start();
  try {
    const laptop = await member(instance, "jack");
    const phone = new Client(instance);
    const phoneDevice = await signInAs(phone, UA.iPhone, "Phone");
    assert.equal(phoneDevice.kind, "phone");
    const tablet = new Client(instance);
    await signInAs(tablet, UA.iPad, "Tablet");

    const devices = await laptop.call(api.devices.list);
    assert.equal(devices.length, 3);
    // What a device is comes from its browser, and a new name doesn't change it.
    assert.deepEqual(Object.fromEntries(devices.map((d) => [d.name, d.kind])), {
      "jack browser": "computer",
      Phone: "phone",
      Tablet: "tablet",
    });
    assert.deepEqual(
      devices.filter((d) => d.current).map((d) => d.name),
      ["jack browser"],
    );
    assert.ok(devices.every((d) => d.signedIn && !d.online));

    // Signed-in devices keep distinct names, whatever the case.
    assert.equal(
      await status(
        laptop.call(api.devices.update, {
          params: { id: phoneDevice.id },
          body: { name: "tablet", kind: "computer" },
        }),
      ),
      409,
    );
    assert.equal((await laptop.call(api.devices.list)).find((d) => d.id === phoneDevice.id)?.kind, "phone");
    assert.equal(
      await status(
        laptop.call(api.devices.update, {
          params: { id: phoneDevice.id },
          body: { name: "Invalid kind", kind: "console" as "computer" },
        }),
      ),
      400,
    );
    assert.equal((await laptop.call(api.devices.list)).find((d) => d.id === phoneDevice.id)?.name, "Phone");
    await laptop.call(api.devices.update, {
      params: { id: phoneDevice.id },
      body: { name: " Edited phone ", kind: "tablet" },
    });
    await laptop.call(api.devices.update, { params: { id: phoneDevice.id }, body: { name: "  Old phone " } });
    assert.equal((await phone.call(api.session.get)).device.kind, "tablet");
    await laptop.call(api.devices.signOut, { params: { id: phoneDevice.id } });
    assert.equal(await status(phone.call(api.session.get)), 401);
    const after = await laptop.call(api.devices.list);
    const old = after.find((d) => d.id === phoneDevice.id)!;
    assert.equal(old.name, "Old phone");
    assert.equal(old.kind, "tablet", "renaming without a kind preserves the edited icon");
    assert.equal(old.signedIn, false, "signed-out devices stay listed");

    const stranger = await member(instance, "kate");
    assert.equal(await status(stranger.call(api.devices.signOut, { params: { id: phoneDevice.id } })), 404);
    assert.equal(
      await status(stranger.call(api.devices.update, { params: { id: phoneDevice.id }, body: { name: "Mine" } })),
      404,
    );

    const { removed } = await laptop.call(api.devices.signOutOthers);
    assert.equal(removed, 1);
    assert.equal(await status(tablet.call(api.session.get)), 401);
    await laptop.call(api.session.get);
  } finally {
    await instance.close();
  }
});

test("the sweep removes expired credentials", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "lena");
    await client.call(api.loginCodes.create);
    const past = Date.now() - 1;
    instance.ctx.db.run("UPDATE sessions SET expires = ?", past);
    instance.ctx.db.run("UPDATE invites SET expires = ?", past);
    await instance.sweep();
    for (const table of ["sessions", "login_codes", "invites"])
      assert.equal(instance.ctx.db.value(`SELECT COUNT(*) FROM ${table}`), 0, table);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM devices"), 2, "devices remain as history");
  } finally {
    await instance.close();
  }
});
