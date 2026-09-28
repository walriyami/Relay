import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { api } from "../shared/api.ts";
import { formatCode } from "../shared/codes.ts";
import {
  codeLengthOf,
  getPickupCode,
  issuePickupCode,
  reconcilePickupCodeMode,
  type PickupCodeKind,
} from "../server/lib/pickup-codes.ts";
import { pickupProtectionOf, recordPickupCodeFailure } from "../server/lib/pickup-code-guard.ts";
import { Secrets, normalizeCode, sha256 } from "../server/lib/secrets.ts";
import { admin, ApiError, Client, member, openShare, send, start, stop } from "./support/harness.ts";

const emptyProtection = (preferredCodeLength: 4 | 6) => ({
  preferredCodeLength,
  pausedUntil: null,
  addressPausedUntil: null,
  heightenedUntil: null,
  lastAttackAt: null,
  numericCodeResolutionUnavailable: false,
});

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

test("the universal namespace retries collisions and keeps stable codes as permanent tombstones", async () => {
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
      assert.equal(getPickupCode(db, secrets, kind, target), issued.code, `${kind} re-displays the same code`);
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

test("recipient expiry, closure, use, and revocation leave permanent namespace tombstones", async () => {
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
      assert.ok(registered, `${kind} code remains permanently reserved`);
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
  } finally {
    await instance.close();
  }
});

test("numeric assignments rotate across recipient types while their URLs remain stable", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    assert.deepEqual(await new Client(instance).call(api.pickup.config), {
      codeLength: 6,
      protection: emptyProtection(6),
    });
    const initialOverview = await boss.call(api.admin.overview);
    assert.equal(initialOverview.codeLength, 6);
    assert.equal(initialOverview.codeProtection.effectiveCodeLength, 6);

    const { result } = await send(boss, [{ path: "rotate.txt", data: "content" }]);
    const link = await boss.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const request = await boss.call(api.requests.create, {
      body: {
        id: crypto.randomUUID(),
        name: "Rotation request",
        description: "",
        days: 7,
        maxBytes: 100,
      },
    });
    const invite = await boss.call(api.admin.invite);
    const device = await boss.call(api.loginCodes.create);
    const oldCodes = [link.code, request.code, invite.code, device.code];
    assert.ok(oldCodes.every((code) => /^\d{3}-\d{3}$/.test(code)));
    assert.ok(new Set(oldCodes).size === oldCodes.length);
    const deviceLinkBefore = await new Client(instance).call(api.session.deviceLinkCheck, {
      params: { token: device.token },
    });

    const topics = new Set<string>();
    instance.ctx.events.flush();
    const userId = (await boss.call(api.session.get)).user.id;
    const unsubscribeOwner = instance.ctx.events.subscribe(userId, (items) =>
      items.forEach((topic) => topics.add(topic)),
    );

    await boss.call(api.admin.settings, { body: { codeLength: 4 } });
    instance.ctx.events.flush();
    unsubscribeOwner();
    assert.deepEqual(await new Client(instance).call(api.pickup.config), {
      codeLength: 4,
      protection: emptyProtection(4),
    });
    assert.ok(["account", "links", "requests", "devices"].every((topic) => topics.has(topic)));

    const newLink = (await boss.call(api.links.list)).find((candidate) => candidate.id === link.id)!;
    const newRequest = (await boss.call(api.requests.list)).find((candidate) => candidate.id === request.id)!;
    const newInvite = (await boss.call(api.admin.invites)).find((candidate) => candidate.code !== invite.code)!;
    const refreshed = await Promise.all(oldCodes.map((code) => boss.call(api.pickup.current, { body: { code } })));
    const newCodes = [newLink.code, newRequest.code, newInvite.code, refreshed[3].code!];
    assert.ok(newCodes.every((code) => /^\d{4}$/.test(code)));
    assert.equal(new Set(newCodes).size, newCodes.length, "the new codes share one collision-free namespace");
    assert.deepEqual(
      refreshed.map(({ code }) => code),
      newCodes,
    );
    assert.notDeepEqual(newCodes, oldCodes);
    assert.equal(await status(new Client(instance).call(api.pickup.resolve, { body: { code: link.code } })), 404);

    // The link tokens and device sign-in link do not change when numeric codes rotate.
    assert.equal((await openShare(new Client(instance), link.token)).name, "rotate.txt");
    assert.equal(
      (await new Client(instance).call(api.requests.open, { params: { token: request.token } })).name,
      "Rotation request",
    );
    assert.ok(
      (await new Client(instance).call(api.session.invitation, { params: { token: invite.token } })).expires >
        Date.now(),
    );
    assert.deepEqual(
      await new Client(instance).call(api.session.deviceLinkCheck, { params: { token: device.token } }),
      deviceLinkBefore,
    );

    await boss.call(api.admin.settings, { body: { codeLength: 6 } });
    assert.deepEqual(await new Client(instance).call(api.pickup.config), {
      codeLength: 6,
      protection: emptyProtection(6),
    });
    const codesAtFour = newCodes;
    const codesAtSix = await Promise.all(
      codesAtFour.map(async (code) => (await boss.call(api.pickup.current, { body: { code } })).code!),
    );
    assert.ok(codesAtSix.every((code) => /^\d{3}-\d{3}$/.test(code)));
    assert.equal(new Set(codesAtSix).size, codesAtSix.length);
    assert.notDeepEqual(codesAtSix, codesAtFour);

    const signedIn = await new Client(instance).call(api.session.deviceLink, {
      body: { token: device.token, deviceName: "Rotated device" },
    });
    assert.equal(signedIn.user.username, "admin");
    assert.equal(
      await status(new Client(instance).call(api.session.deviceLinkCheck, { params: { token: device.token } })),
      410,
    );
  } finally {
    await instance.close();
  }
});

test("four-digit generation covers the full namespace and exhausted rotations roll back", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const { result } = await send(boss, [{ path: "rollback.txt", data: "content" }]);
    const link = await boss.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const originalHash = instance.ctx.db.value<string>("SELECT code_hash FROM links WHERE id = ?", link.id);
    const originalActive = instance.ctx.db.value<number>("SELECT COUNT(*) FROM pickup_codes WHERE retired IS NULL");

    const fourDigitCodes = new Set<string>();
    for (let nonce = 0; nonce < 10_000; nonce++) {
      fourDigitCodes.add(instance.ctx.secrets.pickupCodeFor("share", "full-cycle-check", nonce, 4));
    }
    assert.equal(fourDigitCodes.size, 10_000);
    assert.ok(fourDigitCodes.has("0000"));
    assert.ok(fourDigitCodes.has("0123"));
    assert.equal(formatCode("012345"), "012-345");
    assert.equal(normalizeCode(" 0123 ", 4), "0123");

    const reservedAt = Date.now();
    const reserve = instance.ctx.db.sqlite.prepare(
      "INSERT INTO pickup_codes(code_hash, kind, target_id, nonce, created, retired) VALUES(?, 'share', ?, 0, ?, ?)",
    );
    for (let value = 0; value < 10_000; value++) {
      const digits = String(value).padStart(4, "0");
      reserve.run(instance.ctx.secrets.pickupCodeHash(digits), `reserved-${value}`, reservedAt, reservedAt);
    }

    assert.equal(await status(boss.call(api.admin.settings, { body: { codeLength: 4 } })), 409);
    assert.deepEqual(await new Client(instance).call(api.pickup.config), {
      codeLength: 6,
      protection: emptyProtection(6),
    });
    assert.equal(instance.ctx.db.value("SELECT code_hash FROM links WHERE id = ?", link.id), originalHash);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM pickup_codes WHERE retired IS NULL"), originalActive);
    assert.equal((await boss.call(api.links.list)).find((candidate) => candidate.id === link.id)?.code, link.code);
    assert.throws(
      () => issuePickupCode(instance.ctx.db, instance.ctx.secrets, "request", "exhausted-target", 4),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        error.status === 409 &&
        /No unused 4-digit codes/.test(error.message),
    );

    // Automatic recovery can retain six-digit codes when permanent four-digit tombstones have
    // consumed the namespace. The marker prevents public config reads from repeating the scan.
    instance.ctx.db.setSetting("pickupCodeLength", "4");
    instance.ctx.db.setSetting("pickupCodeEffectiveLength", "6");
    assert.equal(reconcilePickupCodeMode(instance.ctx), false);
    assert.equal(instance.ctx.db.setting("pickupCodeRecoveryBlocked"), "1");
    assert.equal(codeLengthOf(instance.ctx.db), 6);
    const config = await new Client(instance).call(api.pickup.config);
    assert.equal(config.codeLength, 6);
    assert.equal(config.protection.preferredCodeLength, 4);
    assert.equal((await boss.call(api.admin.overview)).codeProtection.effectiveCodeLength, 6);
  } finally {
    await instance.close();
  }
});

test("a failed six-digit security upgrade disables numeric resolution but preserves every bearer URL", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const { result } = await send(boss, [{ path: "fallback.txt", data: "still available" }]);
    const link = await boss.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const request = await boss.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Still available", description: "", days: 7, maxBytes: 100 },
    });
    const invite = await boss.call(api.admin.invite);
    const device = await boss.call(api.loginCodes.create);
    await boss.call(api.admin.settings, { body: { codeLength: 4 } });
    const before = instance.ctx.db.all(
      "SELECT code_hash, kind, target_id, retired FROM pickup_codes WHERE retired IS NULL ORDER BY kind, target_id",
    );

    const originalPickupCodeFor = instance.ctx.secrets.pickupCodeFor.bind(instance.ctx.secrets);
    instance.ctx.secrets.pickupCodeFor = (kind, id, nonce, length) => {
      if (length === 6) throw Object.assign(new Error("No unused 6-digit codes remain."), { status: 409 });
      return originalPickupCodeFor(kind, id, nonce, length);
    };
    const attackAt = Date.now();
    for (let attempt = 0; attempt < 10; attempt++)
      recordPickupCodeFailure(instance.ctx, `198.51.100.${attempt + 1}`, attackAt + attempt);
    assert.equal(reconcilePickupCodeMode(instance.ctx, attackAt + 10), false);
    assert.equal(instance.ctx.db.setting("pickupCodeResolutionUnavailable"), "1");
    assert.deepEqual(
      instance.ctx.db.all(
        "SELECT code_hash, kind, target_id, retired FROM pickup_codes WHERE retired IS NULL ORDER BY kind, target_id",
      ),
      before,
      "failed upgrades roll back the assignment registry intact",
    );

    const config = await new Client(instance).call(api.pickup.config);
    assert.equal(config.protection.numericCodeResolutionUnavailable, true);
    assert.equal(await status(new Client(instance).call(api.pickup.resolve, { body: { code: link.code } })), 503);
    assert.equal(
      await status(new Client(instance).call(api.session.code, { body: { code: device.code, deviceName: "Blocked" } })),
      503,
    );
    assert.deepEqual(await boss.call(api.pickup.current, { body: { code: link.code } }), { code: null });

    const visitor = new Client(instance);
    assert.equal((await openShare(visitor, link.token)).name, "fallback.txt");
    assert.equal((await visitor.call(api.requests.open, { params: { token: request.token } })).name, "Still available");
    assert.ok((await visitor.call(api.session.invitation, { params: { token: invite.token } })).expires > Date.now());
    const pending = await visitor.call(api.session.deviceLinkCheck, { params: { token: device.token } });
    assert.equal(pending.expires, device.expires);
    const signedIn = await visitor.call(api.session.deviceLink, {
      body: { token: device.token, deviceName: "Bearer fallback" },
    });
    assert.equal(signedIn.user.username, "admin");

    assert.throws(
      () => issuePickupCode(instance.ctx.db, instance.ctx.secrets, "request", "blocked-new-request", 4),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 503,
    );
  } finally {
    await instance.close();
  }
});

test("pickup resolution and direct sign-in code attempts share address and global failure budgets", async () => {
  const instance = await start();
  try {
    const bad = (url: string, address: string, body: object) =>
      instance.app.inject({
        method: "POST",
        url,
        headers: { host: "relay.test" },
        remoteAddress: address,
        payload: body,
      });
    for (let attempt = 0; attempt < 9; attempt++) {
      const url = attempt % 2 ? api.session.code.path : api.pickup.resolve.path;
      const body = attempt % 2 ? { code: "000000", deviceName: "Bad" } : { code: "000000" };
      const response = await bad(url, `198.18.0.${attempt + 1}`, body);
      assert.equal(response.statusCode, attempt % 2 ? 410 : 404);
    }
    const globalLimit = await bad(api.session.code.path, "198.18.0.10", { code: "000000", deviceName: "Bad" });
    assert.equal(globalLimit.statusCode, 429);
    assert.equal((await bad(api.pickup.resolve.path, "198.18.0.11", { code: "000000" })).statusCode, 429);
  } finally {
    await instance.close();
  }

  const global = await start();
  try {
    const owner = await member(global, "budget-owner");
    const { result } = await send(owner, [{ path: "public.txt", data: "content" }]);
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const device = await owner.call(api.loginCodes.create);
    const validCodes = new Set([link.code, device.code].map((code) => normalizeCode(code)!));
    let wrong = "000000";
    while (validCodes.has(wrong)) wrong = String(Number(wrong) + 1).padStart(6, "0");

    for (let attempt = 0; attempt < 9; attempt++) {
      const address = `198.18.${Math.floor(attempt / 250)}.${(attempt % 250) + 1}`;
      const session = attempt % 2 === 1;
      const response = await global.app.inject({
        method: "POST",
        url: session ? api.session.code.path : api.pickup.resolve.path,
        headers: { host: "relay.test" },
        remoteAddress: address,
        payload: session ? { code: wrong, deviceName: "Bad" } : { code: wrong },
      });
      assert.equal(response.statusCode, session ? 410 : 404);
    }
    const globalLimit = await global.app.inject({
      method: "POST",
      url: api.session.code.path,
      headers: { host: "relay.test" },
      remoteAddress: "198.18.0.10",
      payload: { code: wrong, deviceName: "Bad" },
    });
    assert.equal(globalLimit.statusCode, 429);
    const limited = await global.app.inject({
      method: "POST",
      url: api.pickup.resolve.path,
      headers: { host: "relay.test" },
      remoteAddress: "203.0.113.200",
      payload: { code: link.code },
    });
    assert.equal(limited.statusCode, 429);
    const limitedSession = await global.app.inject({
      method: "POST",
      url: api.session.code.path,
      headers: { host: "relay.test" },
      remoteAddress: "203.0.113.201",
      payload: { code: device.code, deviceName: "Fresh browser" },
    });
    assert.equal(limitedSession.statusCode, 429);
    assert.equal(global.ctx.db.value("SELECT used FROM login_codes WHERE id = ?", device.id), null);
  } finally {
    await global.close();
  }
});

test("pickup pauses escalate, survive restart, and recover after fifteen quiet minutes", async () => {
  const instance = await start();
  const startedAt = Date.now();
  try {
    recordPickupCodeFailure(instance.ctx, "192.0.2.40", startedAt);
    const savedAtWindowStart = instance.ctx.db.setting("pickupCodeProtection");
    recordPickupCodeFailure(instance.ctx, "192.0.2.42", startedAt + 1);
    assert.equal(
      instance.ctx.db.setting("pickupCodeProtection"),
      savedAtWindowStart,
      "ordinary failures do not write a new SQLite setting for each rejected request",
    );

    const perAddress = "192.0.2.41";
    for (let attempt = 0; attempt < 5; attempt++)
      recordPickupCodeFailure(instance.ctx, perAddress, startedAt + 2 + attempt);
    const addressStatus = pickupProtectionOf(instance.ctx, perAddress, startedAt + 7);
    assert.equal(addressStatus.addressPausedUntil, startedAt + 6 + 60_000);
    assert.equal(addressStatus.lastAttackAt, startedAt + 6);
    assert.equal(addressStatus.heightenedUntil, startedAt + 6 + 15 * 60_000);

    for (let attempt = 0; attempt < 3; attempt++)
      recordPickupCodeFailure(instance.ctx, `198.18.1.${attempt + 1}`, startedAt + 10 + attempt);
    const globalStatus = pickupProtectionOf(instance.ctx, undefined, startedAt + 20);
    assert.equal(globalStatus.pausedUntil, startedAt + 12 + 2 * 60_000);
    assert.equal(globalStatus.heightenedUntil, startedAt + 12 + 15 * 60_000);
  } catch (error) {
    await instance.close();
    throw error;
  }

  const restartAt = Date.now() + 1;
  await stop(instance);
  const restarted = await start({}, instance.root);
  try {
    const restored = pickupProtectionOf(restarted.ctx, "192.0.2.41", restartAt);
    assert.equal(restored.addressPausedUntil, startedAt + 6 + 60_000);
    assert.equal(restored.pausedUntil, startedAt + 12 + 2 * 60_000);

    const secondWaveAt = startedAt + 12 + 2 * 60_000 + 1;
    for (let attempt = 0; attempt < 10; attempt++)
      recordPickupCodeFailure(restarted.ctx, `203.0.113.${attempt + 1}`, secondWaveAt + attempt);
    const escalatedAt = secondWaveAt + 9;
    const escalated = pickupProtectionOf(restarted.ctx, undefined, escalatedAt);
    assert.equal(escalated.pausedUntil, escalatedAt + 4 * 60_000);
    assert.equal(escalated.lastAttackAt, escalatedAt);
    assert.equal(escalated.heightenedUntil, escalatedAt + 15 * 60_000);

    const recovered = pickupProtectionOf(restarted.ctx, undefined, escalatedAt + 15 * 60_000 + 1);
    assert.equal(recovered.pausedUntil, null);
    assert.equal(recovered.heightenedUntil, null);
  } finally {
    await restarted.close();
    await rm(instance.root, { recursive: true, force: true });
  }
});

test("failed owner-only code refreshes do not spend the public pickup guessing budget", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "refresh-owner");
    const { result: activeItem } = await send(owner, [{ path: "active.txt", data: "content" }]);
    const activeLink = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: activeItem.itemId, days: 7 },
    });
    const { result: expiredItem } = await send(owner, [{ path: "expired.txt", data: "expired" }]);
    const expiredLink = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: expiredItem.itemId, days: 7 },
    });
    instance.ctx.db.run("UPDATE links SET expires = ? WHERE id = ?", Date.now() - 1, expiredLink.id);

    for (let attempt = 0; attempt < 70; attempt++)
      assert.deepEqual(await owner.call(api.pickup.current, { body: { code: expiredLink.code } }), { code: null });

    assert.deepEqual(await new Client(instance).call(api.pickup.resolve, { body: { code: activeLink.code } }), {
      kind: "share",
      path: `/s/${activeLink.token}`,
    });
  } finally {
    await instance.close();
  }
});

test("a four-digit code can't be worked out from the six-digit code it replaces", () => {
  const secrets = new Secrets("", "x".repeat(32));
  let suffixes = 0;
  for (let i = 0; i < 200; i++) {
    for (const kind of ["share", "request", "invitation", "device"] as const) {
      const six = normalizeCode(secrets.pickupCodeFor(kind, `target-${i}`, 0, 6), 6)!;
      const four = normalizeCode(secrets.pickupCodeFor(kind, `target-${i}`, 0, 4), 4)!;
      if (six.endsWith(four)) suffixes++;
    }
  }
  // Unrelated sequences share a suffix by chance about once in 10,000 pairs.
  assert.ok(suffixes <= 2, `${suffixes} of 800 four-digit codes were the old code's last digits`);
});

test("links kept until turned off keep a working code when the code length changes", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const { result } = await send(boss, [{ path: "forever.txt", data: "content" }]);
    const link = await boss.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: null },
    });
    assert.equal(link.expires, null);

    await boss.call(api.admin.settings, { body: { codeLength: 4 } });
    const rotated = (await boss.call(api.links.list)).find((candidate) => candidate.id === link.id)!;
    assert.match(rotated.code, /^\d{4}$/);
    assert.deepEqual(await new Client(instance).call(api.pickup.resolve, { body: { code: rotated.code } }), {
      kind: "share",
      path: `/s/${link.token}`,
    });
    assert.equal(
      await boss.call(api.pickup.current, { body: { code: rotated.code } }).then((r) => r.code),
      rotated.code,
    );
  } finally {
    await instance.close();
  }
});
