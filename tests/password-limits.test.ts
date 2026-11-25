import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { LIMITS } from "../shared/model.ts";
import { hashPassword } from "../server/lib/secrets.ts";
import { recordFailure } from "../server/lib/failures.ts";
import { wideNetworkOf } from "../server/modules/auth/limits.ts";
import { rm } from "node:fs/promises";
import { ADMIN_PASSWORD, admin, type ApiError, Client, member, start, stop, type Instance } from "./support/harness.ts";

const MEMBER_PASSWORD = "Member-password-only";

/** A password sign-in from `address`, carrying `cookie` when given. */
const signIn = (instance: Instance, address: string, username: string, password: string, cookie = "") =>
  instance.app.inject({
    method: "POST",
    url: api.session.password.path,
    headers: { host: "relay.test", ...(cookie ? { cookie } : {}) },
    remoteAddress: address,
    payload: { username, password, deviceName: "Test" },
  });

const knownCookieOf = (response: Awaited<ReturnType<typeof signIn>>) => {
  const cookie = response.cookies.find((candidate) => candidate.name.endsWith("relay_known"));
  assert.ok(cookie, "a sign-in marks the browser as known");
  return `${cookie.name}=${cookie.value}`;
};

test("guessing a member's password from many networks can't lock them out of a browser they use", async () => {
  const instance = await start();
  try {
    await member(instance, "victim");
    const before = await signIn(instance, "192.0.2.10", "victim", MEMBER_PASSWORD);
    assert.equal(before.statusCode, 200);
    const known = knownCookieOf(before);

    // Twenty wrong passwords from twenty different networks.
    for (let attempt = 0; attempt < 20; attempt++)
      assert.equal((await signIn(instance, `203.0.${attempt}.1`, "victim", "wrong-password")).statusCode, 401);

    // A new device is asked to wait, and told what still works…
    const stranger = await signIn(instance, "198.51.100.1", "victim", MEMBER_PASSWORD);
    assert.equal(stranger.statusCode, 429);
    assert.match(
      stranger.json<{ error: string }>().error,
      /device you've used before or from where you usually sign in, use a passkey/,
    );

    // …while the member's own browser signs in from anywhere.
    assert.equal((await signIn(instance, "198.51.100.2", "victim", MEMBER_PASSWORD, known)).statusCode, 200);
  } finally {
    await instance.close();
  }
});

test("a known-browser cookie must be signed by this server and only vouches for its own account", async () => {
  const instance = await start();
  try {
    await member(instance, "victim");
    await member(instance, "other");
    const other = knownCookieOf(await signIn(instance, "192.0.2.10", "other", MEMBER_PASSWORD));
    const victimId = instance.ctx.db.value<string>("SELECT id FROM users WHERE username = 'victim'")!;
    const [name] = other.split("=");
    const forged = `${name}=${victimId}.${"A".repeat(22)}`;

    for (let attempt = 0; attempt < 20; attempt++)
      await signIn(instance, `203.0.${attempt}.1`, "victim", "wrong-password");
    for (const cookie of [other, forged])
      assert.equal((await signIn(instance, "198.51.100.3", "victim", MEMBER_PASSWORD, cookie)).statusCode, 429);
  } finally {
    await instance.close();
  }
});

test("a known-browser cookie is each browser's own, and a new password forgets it", async () => {
  const instance = await start();
  try {
    const victim = await member(instance, "victim");
    const first = knownCookieOf(await signIn(instance, "192.0.2.10", "victim", MEMBER_PASSWORD));
    const second = knownCookieOf(await signIn(instance, "192.0.2.10", "victim", MEMBER_PASSWORD));
    assert.notEqual(first, second, "nothing one browser shows works as another's");
    await victim.call(api.account.password, { body: { current: MEMBER_PASSWORD, password: "Another-password-1" } });
    for (let attempt = 0; attempt < 20; attempt++)
      await signIn(instance, `203.0.${attempt}.1`, "victim", "wrong-password");
    assert.equal((await signIn(instance, "198.51.100.3", "victim", "Another-password-1", first)).statusCode, 429);
  } finally {
    await instance.close();
  }
});

test("one network's wrong passwords for an account stop that network only", async () => {
  const instance = await start();
  try {
    await member(instance, "typo");
    // Spread over a /24, as one home or office might be.
    for (let attempt = 0; attempt < 10; attempt++)
      assert.equal((await signIn(instance, `198.18.0.${attempt + 1}`, "typo", "wrong-password")).statusCode, 401);
    const limited = await signIn(instance, "198.18.0.50", "typo", MEMBER_PASSWORD);
    assert.equal(limited.statusCode, 429);
    assert.match(limited.json<{ error: string }>().error, /Try again in about \d+ minutes, or use a passkey/);
    assert.equal((await signIn(instance, "198.18.1.1", "typo", MEMBER_PASSWORD)).statusCode, 200);
  } finally {
    await instance.close();
  }
});

test("a flood of password checks leaves room for a known browser", async () => {
  const instance = await start();
  try {
    await member(instance, "owner");
    const known = knownCookieOf(await signIn(instance, "192.0.2.10", "owner", MEMBER_PASSWORD));
    // Two at a time per network, from 40 networks: more than the password queue holds.
    const flood = Array.from({ length: 80 }, (_, i) =>
      signIn(instance, `2001:db8:${Math.floor(i / 2).toString(16)}::${(i % 2) + 1}`, `nobody${i}`, "wrong-password"),
    );
    const owner = signIn(instance, "192.0.2.11", "owner", MEMBER_PASSWORD, known);
    const results = await Promise.all([...flood, owner]);
    assert.equal(results.at(-1)!.statusCode, 200, "the owner's browser got through");
    assert.ok(
      results.slice(0, -1).some((response) => response.statusCode === 429),
      "the flood itself was turned away in part",
    );
  } finally {
    await instance.close();
  }
});

test("one network can run only a couple of password checks at once", async () => {
  const instance = await start();
  try {
    const statuses = await Promise.all(
      Array.from({ length: 4 }, (_, i) => signIn(instance, `2001:db8:1:${i}::1`, `ghost${i}`, "wrong-password")),
    ).then((responses) => responses.map((response) => response.statusCode).sort());
    assert.deepEqual(statuses, [401, 401, 429, 429], "addresses in one /48 count as one network");
  } finally {
    await instance.close();
  }
});

test("new passwords need at least ten characters; existing shorter ones still sign in", async () => {
  const instance = await start();
  try {
    assert.equal(LIMITS.passwordMin, 10);
    const boss = await admin(instance);
    const invite = await boss.call(api.admin.invite);
    await assert.rejects(
      new Client(instance).call(api.session.join, {
        body: { token: invite.token, username: "shorty", password: "nine-char", deviceName: "Join" },
      }),
      (error: ApiError) => error.status === 400,
    );
    await assert.rejects(
      boss.call(api.account.password, { body: { current: ADMIN_PASSWORD, password: "too-short" } }),
      (error: ApiError) => error.status === 400,
    );
    // A password chosen when six characters were enough keeps working.
    instance.ctx.db.run("UPDATE users SET password_hash = ? WHERE username = 'admin'", await hashPassword("short1"));
    assert.equal((await signIn(instance, "192.0.2.20", "admin", "short1")).statusCode, 200);
  } finally {
    await instance.close();
  }
});

test("joins with a dead invitation are refused before any password work", async () => {
  const instance = await start();
  try {
    // More at once than the password queue holds: none of them waits for it.
    const statuses = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        instance.app.inject({
          method: "POST",
          url: api.session.join.path,
          headers: { host: "relay.test" },
          remoteAddress: `203.0.113.${i + 1}`,
          payload: { token: `dead-${i}`, username: `nobody${i}`, password: MEMBER_PASSWORD, deviceName: "Join" },
        }),
      ),
    ).then((responses) => new Set(responses.map((response) => response.statusCode)));
    assert.deepEqual([...statuses], [410]);
  } finally {
    await instance.close();
  }
});

test("while new devices are locked out, the owner still signs in on a new browser where they usually do", async () => {
  const instance = await start();
  try {
    const victim = await member(instance, "victim");
    // Signed in once from home.
    assert.equal((await signIn(instance, "192.0.2.10", "victim", MEMBER_PASSWORD)).statusCode, 200);
    for (let attempt = 0; attempt < 20; attempt++)
      await signIn(instance, `203.0.${attempt}.1`, "victim", "wrong-password");

    // A new phone at home gets in; the same right password from a stranger's network doesn't.
    assert.equal((await signIn(instance, "192.0.2.77", "victim", MEMBER_PASSWORD)).statusCode, 200);
    assert.equal((await signIn(instance, "198.51.100.1", "victim", MEMBER_PASSWORD)).statusCode, 429);
    // Home's own wrong passwords are still limited, as any network's are.
    for (let attempt = 0; attempt < 10; attempt++)
      assert.equal((await signIn(instance, "192.0.2.78", "victim", "wrong-password")).statusCode, 401);
    assert.equal((await signIn(instance, "192.0.2.79", "victim", MEMBER_PASSWORD)).statusCode, 429);

    // A new password forgets the networks it was used from.
    await victim.call(api.account.password, { body: { current: MEMBER_PASSWORD, password: "Another-password-1" } });
    instance.ctx.db.run("DELETE FROM failures WHERE kind = 'password-network'");
    assert.equal((await signIn(instance, "192.0.2.80", "victim", "Another-password-1")).statusCode, 429);
  } finally {
    await instance.close();
  }
});

test("networks that keep getting passwords wrong wait behind joins and first sign-ins", async () => {
  const instance = await start();
  try {
    await member(instance, "owner");
    const boss = await admin(instance);
    const invite = await boss.call(api.admin.invite);
    // Forty networks that have been guessing all hour.
    const now = Date.now();
    const networks = Array.from({ length: 40 }, (_, i) => `2001:db8:${i.toString(16)}::`);
    for (const network of networks)
      for (let i = 0; i < 3; i++)
        recordFailure(instance.ctx, "password-any-account", [wideNetworkOf(`${network}1`)], now);
    // Two at a time from each: more than the password queue holds.
    const flood = networks.flatMap((network) =>
      [1, 2].map((host) => signIn(instance, `${network}${host}`, `nobody${host}`, "wrong-password")),
    );
    const first = signIn(instance, "192.0.2.20", "owner", MEMBER_PASSWORD);
    const join = instance.app.inject({
      method: "POST",
      url: api.session.join.path,
      headers: { host: "relay.test" },
      remoteAddress: "192.0.2.21",
      payload: { token: invite.token, username: "newcomer", password: MEMBER_PASSWORD, deviceName: "Join" },
    });
    const results = await Promise.all([...flood, first, join]);
    assert.equal(results.at(-2)!.statusCode, 200, "a first sign-in on a clean network got through");
    assert.equal(results.at(-1)!.statusCode, 200, "a join got through");
    assert.ok(
      results.slice(0, -2).some((response) => response.statusCode === 429),
      "the guessing networks were turned away in part",
    );
  } finally {
    await instance.close();
  }
});

test("wrong passwords still count after a restart", async () => {
  const first = await start();
  const root = first.root;
  let again: Instance | undefined;
  try {
    await member(first, "steady");
    for (let attempt = 0; attempt < 10; attempt++)
      assert.equal((await signIn(first, "198.18.3.1", "steady", "wrong-password")).statusCode, 401);
    await stop(first);
    again = await start({}, root);
    assert.equal((await signIn(again, "198.18.3.2", "steady", MEMBER_PASSWORD)).statusCode, 429);
  } finally {
    await (again ?? first).close();
    await rm(root, { recursive: true, force: true });
  }
});
