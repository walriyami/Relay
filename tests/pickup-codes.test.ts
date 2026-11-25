import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import {
  CODE_COOL_DOWN_MS,
  CODE_LIFE_MS,
  CODE_TRIES,
  NEW_CODES_PER_DAY,
  issuePickupCode,
  livePickupCode,
  type PickupCodeKind,
} from "../server/lib/pickup-codes.ts";
import {
  checkCodeAttempt,
  codeNetworkOf,
  lastCodeAttackAt,
  recordCodeFailure,
  wideNetworkOf,
} from "../server/lib/pickup-code-guard.ts";
import { normalizeCode, Secrets, sha256 } from "../server/lib/secrets.ts";
import { rm } from "node:fs/promises";
import type { HttpError } from "../server/lib/errors.ts";
import { admin, Client, member, send, start, stop, type Instance } from "./support/harness.ts";

const errorOf = (response: { json: () => unknown }) => (response.json() as { error: string }).error;

const resolve = (instance: Instance, code: string, address: string) =>
  instance.app.inject({
    method: "POST",
    url: api.pickup.resolve.path,
    headers: { host: "relay.test" },
    remoteAddress: address,
    payload: { code },
  });

test("codes skip digits another recipient holds and stay the same while they work", async () => {
  const instance = await start();
  try {
    const { db, secrets } = instance.ctx;
    const kinds: PickupCodeKind[] = ["share", "request", "invitation", "device"];
    for (const kind of kinds) {
      const target = `target-${kind}`;
      const collisionTarget = `old-${kind}`;
      const code0 = secrets.pickupCodeFor(kind, target, 0);
      // Another kind already holds this target's first code.
      const code0Hash = secrets.pickupCodeHash(normalizeCode(code0)!);
      db.run(
        "INSERT INTO pickup_codes(code_hash, kind, target_id, nonce, created) VALUES(?, ?, ?, ?, ?)",
        code0Hash,
        "share",
        collisionTarget,
        0,
        Date.now(),
      );

      const issued = issuePickupCode(db, secrets, kind, target);
      assert.equal(issued.code, secrets.pickupCodeFor(kind, target, 1), `${kind} retries after a cross-type collision`);
      assert.equal(issued.codeHash, secrets.pickupCodeHash(normalizeCode(issued.code)!));
      assert.notEqual(issued.codeHash, sha256(normalizeCode(issued.code)!), "low-entropy codes are keyed at rest");
      assert.equal(livePickupCode(instance.ctx, kind, target)?.code, issued.code, `${kind} re-displays the same code`);
      assert.deepEqual(issuePickupCode(db, secrets, kind, target), issued, `${kind} is stable on repeat issuance`);
      assert.equal(
        db.value("SELECT COUNT(*) FROM pickup_codes WHERE code_hash = ?", code0Hash),
        1,
        `${kind} collision remains reserved to its original target`,
      );
    }
  } finally {
    await instance.close();
  }
});

test("the resolver follows the single namespace mapping rather than table lookup order", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "namespace-owner");
    const { result } = await send(owner, [{ path: "handoff.txt", data: "content" }]);
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const request = await owner.call(api.requests.create, {
      body: {
        id: crypto.randomUUID(),
        name: "Request",
        description: "",
        days: 7,
        maxBytes: 100,
      },
    });

    // Simulate stale/corrupt data in a secondary source table. The namespace mapping remains the
    // sole routing authority, so a request code must continue to resolve as a request.
    const requestHash = instance.ctx.secrets.pickupCodeHash(normalizeCode(request.code)!);
    instance.ctx.db.run("UPDATE links SET code_hash = ? WHERE id = ?", requestHash, link.id);
    assert.deepEqual(await new Client(instance).call(api.pickup.resolve, { body: { code: request.code } }), {
      kind: "request",
      path: `/r/${request.token}`,
    });
  } finally {
    await instance.close();
  }
});

test("an ended recipient keeps its code reserved, so a remembered code never opens something else", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const { result } = await send(boss, [{ path: "tombstone.txt", data: "content" }]);
    const link = await boss.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const request = await boss.call(api.requests.create, {
      body: {
        id: crypto.randomUUID(),
        name: "Closed request",
        description: "",
        days: 7,
        maxBytes: 100,
      },
    });
    const usedInvite = await boss.call(api.admin.invite);
    const revokedInvite = await boss.call(api.admin.invite);
    const usedInviteId = instance.ctx.db.value<string>(
      "SELECT id FROM invites WHERE token_hash = ?",
      sha256(usedInvite.token),
    );
    const revokedInviteId = instance.ctx.db.value<string>(
      "SELECT id FROM invites WHERE token_hash = ?",
      sha256(revokedInvite.token),
    );
    assert.ok(usedInviteId && revokedInviteId);
    const device = await boss.call(api.loginCodes.create);
    const hash = (code: string) => instance.ctx.secrets.pickupCodeHash(normalizeCode(code)!);

    await boss.call(api.links.revoke, { params: { id: link.id } });
    await boss.call(api.requests.close, { params: { id: request.id } });
    await new Client(instance).call(api.session.join, {
      body: {
        token: usedInvite.token,
        username: "namespace-join",
        password: "Member-password-only",
        deviceName: "Join",
      },
    });
    await boss.call(api.admin.revokeInvite, { params: { id: revokedInviteId } });
    await boss.call(api.loginCodes.revoke, { params: { id: device.id } });
    await instance.sweep();

    for (const [kind, target, code] of [
      ["share", link.id, link.code],
      ["request", request.id, request.code],
      ["invitation", usedInviteId, usedInvite.code],
      ["invitation", revokedInviteId, revokedInvite.code],
      ["device", device.id, device.code],
    ] as [PickupCodeKind, string | undefined, string][]) {
      const registered = instance.ctx.db.get<{ code_hash: string; kind: string; target_id: string }>(
        "SELECT code_hash, kind, target_id FROM pickup_codes WHERE code_hash = ?",
        hash(code),
      );
      assert.ok(registered, `${kind} code stays reserved`);
      assert.equal(registered.kind, kind);
      assert.equal(registered.target_id, target);
    }
    assert.ok(
      instance.ctx.db.value(
        "SELECT retired FROM pickup_codes WHERE kind = 'invitation' AND target_id = ?",
        revokedInviteId,
      ),
      "deleting a revoked invitation retires its assignment",
    );
    assert.ok(
      instance.ctx.db.value("SELECT retired FROM pickup_codes WHERE kind = 'device' AND target_id = ?", device.id),
      "sweeping a deleted sign-in code retires its assignment",
    );
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM login_codes WHERE id = ?", device.id), 0);
    assert.equal(
      instance.ctx.db.value("SELECT COUNT(*) FROM invites WHERE token_hash = ?", sha256(revokedInvite.token)),
      0,
    );

    // Every ended code answers exactly as one that never existed, so guessing learns nothing.
    const used = new Set(
      [link.code, request.code, usedInvite.code, revokedInvite.code, device.code].map(normalizeCode),
    );
    const never = ["000000", "000001", "000002", "000003", "000004", "000005"].find((code) => !used.has(code))!;
    const unknown = await resolve(instance, never, "198.18.10.1");
    assert.equal(unknown.statusCode, 404);
    for (const [i, code] of [link.code, request.code, usedInvite.code, revokedInvite.code, device.code].entries()) {
      const ended = await resolve(instance, code, `198.18.${11 + i}.1`);
      assert.equal(ended.statusCode, 404, code);
      assert.equal(errorOf(ended), errorOf(unknown));
    }
  } finally {
    await instance.close();
  }
});

/** Moves a recipient's code back in time, as if it had been issued `ms` ago. */
function age(instance: Instance, kind: PickupCodeKind, targetId: string, ms: number) {
  instance.ctx.db.run(
    "UPDATE pickup_codes SET created = created - ? WHERE kind = ? AND target_id = ? AND retired IS NULL",
    ms,
    kind,
    targetId,
  );
}

test("a code stops working after a day, and the owner sees a fresh one while the link stays the same", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "day-owner");
    const { result } = await send(owner, [{ path: "today.txt", data: "content" }]);
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    assert.match(link.code, /^\d{3}-\d{3}$/);
    const current = await owner.call(api.pickup.current, { body: { code: link.code } });
    assert.equal(current.code, link.code);
    assert.ok(current.expires! > Date.now() + CODE_LIFE_MS - 60_000 && current.expires! <= Date.now() + CODE_LIFE_MS);

    age(instance, "share", link.id, CODE_LIFE_MS + 1);
    assert.equal((await resolve(instance, link.code, "198.18.1.1")).statusCode, 404, "a day-old code is spent");

    const fresh = await owner.call(api.pickup.current, { body: { code: link.code } });
    assert.ok(fresh.code && fresh.code !== link.code, "the owner's screen asks for the new code");
    const listed = (await owner.call(api.links.list)).find((candidate) => candidate.id === link.id)!;
    assert.equal(listed.code, fresh.code);
    assert.equal(listed.token, link.token, "the link and QR code don't change");
    assert.deepEqual(await new Client(instance).call(api.pickup.resolve, { body: { code: fresh.code } }), {
      kind: "share",
      path: `/s/${link.token}`,
    });

    // A closed recipient isn't given a new code.
    await owner.call(api.links.revoke, { params: { id: link.id } });
    age(instance, "share", link.id, CODE_LIFE_MS + 1);
    assert.deepEqual(await owner.call(api.pickup.current, { body: { code: fresh.code } }), {
      code: null,
      expires: null,
    });
    assert.equal(livePickupCode(instance.ctx, "share", link.id, false), null);
  } finally {
    await instance.close();
  }
});

test("a code's digits are free again only after a month's cool-down", async () => {
  const instance = await start();
  try {
    const { db, secrets } = instance.ctx;
    const now = Date.now();
    const hold = (target: string, created: number, retired: number | null) => {
      const code = secrets.pickupCodeFor("share", "new-target", 0);
      db.run(
        "INSERT INTO pickup_codes(code_hash, kind, target_id, nonce, created, retired) VALUES(?, 'request', ?, 0, ?, ?)",
        secrets.pickupCodeHash(normalizeCode(code)!),
        target,
        created,
        retired,
      );
    };

    // Retired a little under a month ago: still reserved.
    hold("recent", now - 40 * CODE_LIFE_MS, now - CODE_COOL_DOWN_MS + 60_000);
    assert.equal(
      issuePickupCode(db, secrets, "share", "new-target", now).code,
      secrets.pickupCodeFor("share", "new-target", 1),
    );
    db.run("DELETE FROM pickup_codes");

    // Retired over a month ago: free, and the old recipient keeps a row so its id is never reused.
    hold("long-ago", now - 40 * CODE_LIFE_MS, now - CODE_COOL_DOWN_MS - 1);
    assert.equal(
      issuePickupCode(db, secrets, "share", "new-target", now).code,
      secrets.pickupCodeFor("share", "new-target", 0),
    );
    assert.match(db.value<string>("SELECT code_hash FROM pickup_codes WHERE target_id = 'long-ago'")!, /^released:/);
    db.run("DELETE FROM pickup_codes");

    // Never retired but issued long ago: it ended a day after issue, so it's free too.
    hold("forgotten", now - CODE_COOL_DOWN_MS - CODE_LIFE_MS - 1, null);
    assert.equal(
      issuePickupCode(db, secrets, "share", "new-target", now).code,
      secrets.pickupCodeFor("share", "new-target", 0),
    );
  } finally {
    await instance.close();
  }
});

test("wrong codes slow down only the network sending them", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "slow-owner");
    const { result } = await send(owner, [{ path: "public.txt", data: "content" }]);
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const wrong = normalizeCode(link.code) === "000000" ? "000001" : "000000";

    for (let attempt = 0; attempt < 5; attempt++)
      assert.equal((await resolve(instance, wrong, "198.18.2.1")).statusCode, 404);
    const limited = await resolve(instance, link.code, "198.18.2.1");
    assert.equal(limited.statusCode, 429, "even a right code waits once the network has guessed too often");
    assert.match(errorOf(limited), /paused here for about 15 minutes\. The link or QR code you were sent still works/);

    // Sign-in codes share the same count.
    const signIn = await instance.app.inject({
      method: "POST",
      url: api.session.code.path,
      headers: { host: "relay.test" },
      remoteAddress: "198.18.2.1",
      payload: { code: wrong, deviceName: "Guess" },
    });
    assert.equal(signIn.statusCode, 429);

    // Everyone else, including the neighbour on the same street, carries on.
    assert.equal((await resolve(instance, link.code, "198.18.2.2")).statusCode, 200);
    assert.equal((await resolve(instance, link.code, "198.18.3.1")).statusCode, 200);
  } finally {
    await instance.close();
  }
});

test("during a guessing attack each wider network gets a few tries, and right codes keep working", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const { result } = await send(boss, [{ path: "public.txt", data: "content" }]);
    const link = await boss.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const wrong = normalizeCode(link.code) === "000000" ? "000001" : "000000";
    assert.equal((await boss.call(api.admin.overview)).codeAttackAt, null);

    // Thirty wrong codes, each from a different network, mean someone is guessing.
    for (let attempt = 0; attempt < 30; attempt++)
      assert.equal((await resolve(instance, wrong, `203.0.${attempt}.7`)).statusCode, 404);
    const alerted = (await boss.call(api.admin.overview)).codeAttackAt;
    assert.ok(alerted && alerted <= Date.now(), "Admin shows when the guessing happened");

    // Now a wider network may only guess three times a day…
    for (let host = 1; host <= 2; host++)
      assert.equal((await resolve(instance, wrong, `198.51.100.${host}`)).statusCode, 404);
    assert.equal((await resolve(instance, wrong, "198.51.100.3")).statusCode, 404);
    const capped = await resolve(instance, link.code, "198.51.100.4");
    assert.equal(capped.statusCode, 429);
    assert.match(errorOf(capped), /about \d+ hours/);

    // …while a right code from anywhere else still works, and code entry never pauses for everyone.
    const right = await resolve(instance, link.code, "192.0.2.1");
    assert.equal(right.statusCode, 200);
    assert.deepEqual(right.json(), { kind: "share", path: `/s/${link.token}` });
  } finally {
    await instance.close();
  }
});

test("networks are grouped the way providers hand them out", () => {
  assert.equal(wideNetworkOf("198.51.100.23"), "198.51.100.0/24");
  assert.equal(wideNetworkOf("::ffff:198.51.100.23"), "198.51.100.0/24");
  assert.equal(wideNetworkOf("2001:db8:1234:5678::1"), "2001:db8:1234::/48");
});

test("the guard forgets a network's wrong codes once its window has passed", async () => {
  const instance = await start();
  try {
    const t0 = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) recordCodeFailure(instance.ctx, "198.18.4.1", t0);
    assert.throws(() => checkCodeAttempt(instance.ctx, "198.18.4.1", t0), { status: 429 });
    checkCodeAttempt(instance.ctx, "198.18.4.1", t0 + 15 * 60_000 + 1);
    // A day's worth of typos is still capped, even when spread out.
    for (let attempt = 0; attempt < 15; attempt++)
      recordCodeFailure(instance.ctx, "198.18.4.1", t0 + (attempt + 1) * 20 * 60_000);
    assert.throws(() => checkCodeAttempt(instance.ctx, "198.18.4.1", t0 + 6 * 3_600_000), { status: 429 });
    checkCodeAttempt(instance.ctx, "198.18.4.1", t0 + 30 * 3_600_000);
  } finally {
    await instance.close();
  }
});

test("wrong codes still count after a restart, and old ones are cleared out after a day", async () => {
  const first = await start();
  const root = first.root;
  let again: Instance | undefined;
  try {
    const t0 = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) recordCodeFailure(first.ctx, "198.18.5.1", t0);
    await stop(first);
    again = await start({}, root);
    assert.throws(() => checkCodeAttempt(again!.ctx, "198.18.5.1", t0 + 1000), { status: 429 });
    // A day later, the next wrong code clears the old rows away.
    recordCodeFailure(again.ctx, "198.18.6.1", t0 + 24 * 3_600_000 + 1);
    assert.equal(again.ctx.db.value("SELECT count(*) FROM failures WHERE time = ?", t0), 0);
    checkCodeAttempt(again.ctx, "198.18.5.1", t0 + 24 * 3_600_000 + 1);
  } finally {
    await (again ?? first).close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a network's addresses share one day's wrong codes, and an IPv6 neighbour has its own", async () => {
  const instance = await start();
  try {
    const t0 = Date.now();
    const { ctx } = instance;
    // The alarm for guessing from everywhere is a separate limit; this test is about one network.
    const calm = () => ctx.db.setSetting("pickupCodeAttackUntil", "0");
    // Fifty wrong codes, five from each of ten addresses in one /24, spread over the day.
    for (let i = 0; i < 50; i++) recordCodeFailure(ctx, `198.18.7.${1 + (i % 10)}`, t0 + i * 20 * 60_000);
    calm();
    const later = t0 + 50 * 20 * 60_000;
    assert.throws(() => checkCodeAttempt(ctx, "198.18.7.200", later), { status: 429 });
    checkCodeAttempt(ctx, "198.18.8.1", later);

    // IPv6: one home's /56 is capped the same way, but the next /56 in the same /48 isn't.
    ctx.db.run("DELETE FROM failures");
    for (let i = 0; i < 50; i++)
      recordCodeFailure(ctx, `2001:db8:1:${((i % 10) + 1).toString(16)}::1`, later + i * 20 * 60_000);
    calm();
    const last = later + 50 * 20 * 60_000;
    assert.throws(
      () => checkCodeAttempt(ctx, "2001:db8:1:ff::1", last),
      (error: HttpError) => {
        assert.equal(error.status, 429);
        assert.match(error.message, /from your network.*The link or QR code you were sent still works/);
        return true;
      },
    );
    checkCodeAttempt(ctx, "2001:db8:1:100::1", last);
    assert.equal(codeNetworkOf("2001:db8:1:1ff::1"), "2001:db8:1:100::/56");
    assert.equal(codeNetworkOf("198.18.7.9"), "198.18.7.0/24");
  } finally {
    await instance.close();
  }
});

test("slow guessing from everywhere raises the alarm within a day", async () => {
  const instance = await start();
  try {
    const t0 = Date.now();
    const { ctx } = instance;
    // One wrong code every 25 minutes from a new network never makes 30 in an hour…
    let started = false;
    for (let i = 0; i < 49; i++) if (recordCodeFailure(ctx, `203.0.${i}.7`, t0 + i * 25 * 60_000)) started = true;
    assert.equal(started, false);
    assert.equal(lastCodeAttackAt(ctx), null);
    // …but fifty in a day are someone guessing.
    const at = t0 + 49 * 25 * 60_000;
    assert.equal(recordCodeFailure(ctx, "203.0.49.7", at), true);
    assert.equal(lastCodeAttackAt(ctx), at);
    // Each network now gets only a few wrong codes.
    for (let i = 0; i < 3; i++) recordCodeFailure(ctx, "198.18.9.1", at);
    assert.throws(() => checkCodeAttempt(ctx, "198.18.9.2", at), { status: 429 });
  } finally {
    await instance.close();
  }
});

test("one account can't make sign-in codes without end", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "many-codes");
    const first = await owner.call(api.loginCodes.create);
    for (let i = 0; i < 99; i++)
      instance.ctx.db.run(
        `INSERT INTO login_codes(id, user_id, session_hash, code_hash, device_token_hash, created, expires, revoked)
         SELECT ?, user_id, session_hash, ?, ?, created, expires, created FROM login_codes WHERE id = ?`,
        `filler-${i}`,
        `filler-code-${i}`,
        `filler-token-${i}`,
        first.id,
      );
    await assert.rejects(owner.call(api.loginCodes.create), (error: HttpError) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /sign-in link/);
      return true;
    });
  } finally {
    await instance.close();
  }
});

test("however many networks guess, all of them together get a fixed number of wrong codes a day", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "budget-owner");
    const { result } = await send(owner, [{ path: "budget.txt", data: "content" }]);
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const { ctx } = instance;
    const t0 = Date.now() - 60_000;
    // 300 wrong codes from 300 different IPv6 /48s, each well inside its own limits.
    for (let i = 0; i < 300; i++) recordCodeFailure(ctx, `2001:db8:${i.toString(16)}::1`, t0);

    // A brand-new network is refused even a right code…
    const fresh = await resolve(instance, link.code, "2001:db8:ffff::1");
    assert.equal(fresh.statusCode, 429);
    assert.match(errorOf(fresh), /Codes are paused for now.*The link or QR code you were sent still works/);
    // …a signed-in member isn't…
    assert.deepEqual(await owner.call(api.pickup.resolve, { body: { code: link.code } }), {
      kind: "share",
      path: `/s/${link.token}`,
    });
    // …and a day after the oldest of them, codes work again.
    checkCodeAttempt(ctx, "2001:db8:ffff::1", t0 + 24 * 3_600_000 + 1);
  } finally {
    await instance.close();
  }
});

test("listing links doesn't issue new codes; the share screen asks for one when it shows it", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "lazy-owner");
    const { result } = await send(owner, [{ path: "lazy.txt", data: "content" }]);
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    age(instance, "share", link.id, CODE_LIFE_MS + 1);
    const issued = () =>
      instance.ctx.db.value<number>("SELECT count(*) FROM pickup_codes WHERE target_id = ?", link.id) ?? 0;
    const before = issued();
    const [listed] = await owner.call(api.links.list);
    assert.equal(listed.code, link.code, "the list shows the last code, which the screen asks about");
    assert.equal(issued(), before, "no new code until the owner looks at this link");
    const current = await owner.call(api.pickup.current, { body: { code: listed.code } });
    assert.ok(current.code && current.code !== link.code);
    assert.equal(issued(), before + 1);
  } finally {
    await instance.close();
  }
});

test("a nearly full code space gives up after a few tries instead of stalling the server", async () => {
  const instance = await start();
  try {
    const { db, secrets } = instance.ctx;
    const now = Date.now();
    const hold = (nonce: number) =>
      db.run(
        "INSERT INTO pickup_codes(code_hash, kind, target_id, nonce, created) VALUES(?, 'request', ?, 0, ?)",
        secrets.pickupCodeHash(normalizeCode(secrets.pickupCodeFor("share", "crowded", nonce))!),
        `holder-${nonce}`,
        now,
      );
    for (let nonce = 0; nonce < CODE_TRIES - 1; nonce++) hold(nonce);
    assert.equal(
      issuePickupCode(db, secrets, "share", "crowded", now).code,
      secrets.pickupCodeFor("share", "crowded", CODE_TRIES - 1),
      "the last allowed try still finds a free code",
    );
    db.run("DELETE FROM pickup_codes WHERE target_id = 'crowded'");
    hold(CODE_TRIES - 1);
    assert.throws(
      () => issuePickupCode(db, secrets, "share", "crowded", now),
      (error: HttpError) => error.status === 503 && /nothing new was made/.test(error.message),
    );

    // A recipient's next code carries on from its last one rather than trying its own old codes.
    db.run("DELETE FROM pickup_codes");
    let day = now;
    for (let i = 0; i < CODE_TRIES + 5; i++, day += CODE_LIFE_MS)
      assert.equal(
        issuePickupCode(db, secrets, "share", "daily", day).code,
        secrets.pickupCodeFor("share", "daily", i),
      );
  } finally {
    await instance.close();
  }
});

test("one member's things get a fixed number of new codes a day, renewals included", async () => {
  const instance = await start();
  try {
    const { db } = instance.ctx;
    const owner = await member(instance, "busy-maker");
    const userId = db.value<string>("SELECT id FROM users WHERE username = 'busy-maker'")!;
    const { result } = await send(owner, [{ path: "a.txt", data: "alpha", mime: "text/plain" }]);
    const request = () =>
      owner.call(api.requests.create, {
        body: { id: crypto.randomUUID(), name: "Papers", description: "", days: 5, maxBytes: 1000 },
      });
    const share = () =>
      owner.call(api.links.create, { body: { id: crypto.randomUUID(), item: result.itemId, days: 7 } });
    const open = await request();
    await share();
    const now = Date.now();
    for (let i = 2; i < NEW_CODES_PER_DAY; i++)
      db.run("INSERT INTO failures(kind, key, time) VALUES('new-code', ?, ?)", userId, now);
    const refused = (error: HttpError) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /try again tomorrow/);
      return true;
    };
    await assert.rejects(request(), refused);
    await assert.rejects(share(), refused);
    await assert.rejects(owner.call(api.nearby.invite), refused);
    assert.equal(db.value("SELECT count(*) FROM requests"), 1, "a refused request leaves nothing behind");

    // An open request's code that has run out isn't renewed either; the list still loads, without it.
    db.run("UPDATE pickup_codes SET created = created - ? WHERE target_id = ?", CODE_LIFE_MS, open.id);
    assert.deepEqual(
      (await owner.call(api.requests.list)).map((listed) => listed.code),
      [""],
    );

    // Someone else still can, and the allowance comes back a day later.
    const other = await member(instance, "other-maker");
    await other.call(api.nearby.invite);
    db.run("UPDATE failures SET time = time - ? WHERE kind = 'new-code'", CODE_LIFE_MS);
    assert.match((await owner.call(api.requests.list))[0].code, /^\d{3}-\d{3}$/);
    await request();
  } finally {
    await instance.close();
  }
});

test("when no free code turns up, the owner's list still loads and only that code is missing", async () => {
  const instance = await start();
  try {
    const { db, secrets } = instance.ctx;
    const owner = await member(instance, "crowded-owner");
    const open = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Papers", description: "", days: 5, maxBytes: 1000 },
    });
    db.run("UPDATE pickup_codes SET created = created - ? WHERE target_id = ?", CODE_LIFE_MS, open.id);
    for (let nonce = 1; nonce <= CODE_TRIES; nonce++)
      db.run(
        "INSERT INTO pickup_codes(code_hash, kind, target_id, nonce, created) VALUES(?, 'share', ?, 0, ?)",
        secrets.pickupCodeHash(normalizeCode(secrets.pickupCodeFor("request", open.id, nonce))!),
        `holder-${nonce}`,
        Date.now(),
      );
    assert.deepEqual(
      (await owner.call(api.requests.list)).map((listed) => listed.code),
      [""],
    );
  } finally {
    await instance.close();
  }
});

test("after the secret key changes, owners are shown fresh codes instead of an error", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "rekeyed");
    const created = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Papers", description: "", days: 5, maxBytes: 1000 },
    });
    const { result } = await send(owner, [{ path: "a.txt", data: "alpha", mime: "text/plain" }]);
    const shared = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    (instance.ctx as { secrets: Secrets }).secrets = new Secrets(instance.root, "a-different-key-".repeat(3));
    const [listed] = await owner.call(api.requests.list);
    assert.match(listed.code, /^\d{3}-\d{3}$/);
    assert.notEqual(listed.code, created.code, "the request's code from the old key is replaced");
    const [link] = await owner.call(api.links.list);
    assert.match(link.code, /^\d{3}-\d{3}$/);
    assert.notEqual(link.code, shared.code, "the share's code from the old key is replaced");
    for (const id of [created.id, shared.id])
      assert.equal(
        instance.ctx.db.value("SELECT count(*) FROM pickup_codes WHERE target_id = ? AND retired IS NULL", id),
        1,
      );
  } finally {
    await instance.close();
  }
});
