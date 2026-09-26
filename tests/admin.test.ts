import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { DEFAULTS } from "../shared/model.ts";
import { admin, ApiError, Client, member, patchUpload, send, start } from "./support/harness.ts";
import { sha256 } from "../server/lib/secrets.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

test("the overview reports members, storage, limits and activity", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const zoe = await member(instance, "zoe", boss);
    await send(zoe, [{ path: "a.bin", data: Buffer.alloc(300, 1) }]);
    await zoe.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: zoe.tab,
        name: null,
        folders: [],
        files: [{ path: "big.bin", size: 5000, mime: "" }],
      },
    });

    const overview = await boss.call(api.admin.overview);
    assert.deepEqual(
      overview.members.map((m) => [m.username, m.admin, m.disabled]),
      [
        ["admin", true, false],
        ["zoe", false, false],
      ],
    );
    const zoeRow = overview.members[1];
    assert.deepEqual(zoeRow.usage, { used: 300, reserved: 5000, quota: DEFAULTS.quotaBytes });
    assert.equal(overview.storage.used, 300);
    assert.equal(overview.storage.reserved, 5000);
    assert.equal(overview.storage.capacity, DEFAULTS.capacityBytes);
    assert.ok(overview.storage.diskTotal > 0 && overview.storage.diskFree > 0);
    assert.deepEqual(overview.limits, {
      capacity: DEFAULTS.capacityBytes,
      maxFileBytes: DEFAULTS.maxFileBytes,
    });
    assert.equal("backup" in overview, false);
    assert.equal(overview.activity.activeUploads, 1);
    assert.equal(overview.activity.receivedBytesLastHour >= 0, true);

    await boss.call(api.admin.settings, { body: { capacity: 10_000 } });
    const changed = await boss.call(api.admin.overview);
    assert.equal(changed.limits.capacity, 10_000);
    assert.equal(changed.storage.capacity, 10_000);
    assert.equal(changed.limits.maxFileBytes, DEFAULTS.maxFileBytes);
    const rejectedBackupSetting = await boss.raw({
      method: "PATCH",
      url: "/api/admin/settings",
      payload: { backupKeep: 3 },
    });
    assert.equal(rejectedBackupSetting.statusCode, 400, "backup retention is not a product setting");
    assert.equal(instance.ctx.db.setting("backupKeep"), undefined, "the web API cannot change operator policy");
  } finally {
    await instance.close();
  }
});

test("members cannot use administration", async () => {
  const instance = await start();
  try {
    const plain = await member(instance, "abel");
    const { user } = await plain.call(api.session.get);
    const calls = [
      () => plain.call(api.admin.overview),
      () => plain.call(api.admin.invite),
      () => plain.call(api.admin.invites),
      () => plain.call(api.admin.revokeInvite, { params: { id: "0".repeat(64) } }),
      () => plain.call(api.admin.updateMember, { params: { id: user.id }, body: { quota: 1 } }),
      () => plain.call(api.admin.resetPassword, { params: { id: user.id }, body: { password: "Some-new-password" } }),
      () => plain.call(api.admin.settings, { body: { capacity: 1 } }),
    ];
    for (const call of calls) assert.equal(await status(call()), 403);
    assert.equal(await status(new Client(instance).call(api.admin.overview)), 401);
    assert.equal((await plain.call(api.session.get)).user.quota, DEFAULTS.quotaBytes);
  } finally {
    await instance.close();
  }
});

test("pending invitations can be listed and withdrawn", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const first = await boss.call(api.admin.invite);
    const second = await boss.call(api.admin.invite, { body: { note: "  For Sam  " } });
    const used = await boss.call(api.admin.invite);
    assert.match(first.code, /^\d{3}-\d{3}$/);
    const stored = instance.ctx.db.get<{ token_hash: string; code_hash: string }>(
      "SELECT token_hash, code_hash FROM invites WHERE token_hash = ?",
      sha256(first.token),
    )!;
    assert.equal(stored.token_hash, sha256(first.token));
    assert.equal(stored.code_hash, instance.ctx.secrets.pickupCodeHash(first.code.replace("-", "")));
    assert.deepEqual(await new Client(instance).call(api.pickup.resolve, { body: { code: first.code } }), {
      kind: "invitation",
      path: `/join/${first.token}`,
    });
    await new Client(instance).call(api.session.join, {
      body: { token: used.token, username: "ivy", password: "Member-password-only" },
    });
    assert.equal(await status(new Client(instance).call(api.pickup.resolve, { body: { code: used.code } })), 410);

    const pending = await boss.call(api.admin.invites);
    assert.equal(pending.length, 2, "used invitations are not pending");
    assert.deepEqual(
      pending.map((i) => [i.expires, i.createdBy, i.note]),
      [
        [second.expires, "admin", "For Sam"],
        [first.expires, "admin", null],
      ],
    );
    for (const invite of pending) {
      assert.ok(!JSON.stringify(invite).includes(first.token) && !JSON.stringify(invite).includes(second.token));
      assert.ok(invite.created <= invite.expires);
    }

    // Withdrawing the older one makes its link unusable at once; the other still works.
    await boss.call(api.admin.revokeInvite, { params: { id: pending[1].id } });
    const refused = new Client(instance).call(api.session.invitation, { params: { token: first.token } });
    assert.equal(await status(refused), 410);
    const joinWithdrawn = new Client(instance).call(api.session.join, {
      body: { token: first.token, username: "jon", password: "Member-password-only" },
    });
    assert.equal(await status(joinWithdrawn), 410);
    assert.equal(await status(boss.call(api.admin.revokeInvite, { params: { id: pending[1].id } })), 404);
    assert.deepEqual(
      (await boss.call(api.admin.invites)).map((i) => i.id),
      [pending[0].id],
    );
    await new Client(instance).call(api.session.invitation, { params: { token: second.token } });

    // A used invitation cannot be withdrawn: the account it made stays.
    const usedId = instance.ctx.db.value<string>("SELECT token_hash FROM invites WHERE used IS NOT NULL")!;
    assert.equal(await status(boss.call(api.admin.revokeInvite, { params: { id: usedId } })), 404);
    assert.equal(await status(new Client(instance).call(api.admin.invites)), 401);
  } finally {
    await instance.close();
  }
});

test("the overview counts the devices each member has signed in", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const kit = await member(instance, "kit", boss);
    await new Client(instance).signIn("kit", "Member-password-only", "Phone");
    const count = async () =>
      (await boss.call(api.admin.overview)).members.find((m) => m.username === "kit")!.signedInDevices;
    assert.equal(await count(), 2);
    await kit.call(api.devices.signOutOthers);
    assert.equal(await count(), 1);
    const { user } = await kit.call(api.session.get);
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
    assert.equal(await count(), 0);
  } finally {
    await instance.close();
  }
});

test("member management: quota, retention, disabling and password reset", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const bea = await member(instance, "bea", boss);
    const { user } = await bea.call(api.session.get);
    const bossId = (await boss.call(api.session.get)).user.id;
    instance.ctx.db.run(
      "INSERT INTO passkeys(id, user_id, public_key, counter, transports, name, created) VALUES(?, ?, ?, ?, ?, ?, ?)",
      "bea-test-passkey",
      user.id,
      Buffer.from([1, 2, 3]),
      0,
      "[]",
      "Test key",
      Date.now(),
    );

    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { quota: 1234, retentionDays: 14 } });
    const me = await bea.call(api.session.get);
    assert.equal(me.user.quota, 1234);
    assert.equal(me.user.retentionDays, 14);
    assert.equal(
      await status(boss.call(api.admin.updateMember, { params: { id: bossId }, body: { disabled: true } })),
      409,
    );
    assert.equal(
      await status(boss.call(api.admin.updateMember, { params: { id: crypto.randomUUID() }, body: { quota: 1 } })),
      404,
    );

    await boss.call(api.admin.resetPassword, { params: { id: user.id }, body: { password: "Reset-by-the-admin" } });
    assert.equal(await status(bea.call(api.session.get)), 401, "sessions are revoked");
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM passkeys WHERE user_id = ?", user.id), 0);
    const fresh = new Client(instance);
    await fresh.signIn("bea", "Reset-by-the-admin");

    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
    assert.equal(await status(fresh.call(api.session.get)), 401);
    assert.equal((await boss.call(api.admin.overview)).members.find((m) => m.id === user.id)?.disabled, true);
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: false } });
    await new Client(instance).signIn("bea", "Reset-by-the-admin");
  } finally {
    await instance.close();
  }
});

test("backup administration endpoints are removed", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const formerBackupPost = await boss.raw({ method: "POST", url: "/api/admin/backups" });
    const formerBackupStatus = await boss.raw({ method: "GET", url: "/api/admin/backups" });
    assert.equal(formerBackupPost.statusCode, 404);
    assert.equal(formerBackupStatus.statusCode, 404);
  } finally {
    await instance.close();
  }
});

test("the upload admission reads the capacity the administrator sets", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    await boss.call(api.admin.settings, { body: { capacity: 1000, maxFileBytes: 500 } });
    const create = (size: number) =>
      boss.call(api.transfers.create, {
        body: {
          id: crypto.randomUUID(),
          tab: boss.tab,
          name: null,
          folders: [],
          files: [{ path: `f-${size}.bin`, size, mime: "" }],
        },
      });
    assert.equal(await status(create(600)), 413, "larger than the maximum file size");
    const ok = await create(400);
    assert.equal((await patchUpload(boss, ok.uploads[0].id, 0, Buffer.alloc(400))).statusCode, 204);
    await create(400);
    assert.ok([413, 507].includes(await status(create(400))), "over the service capacity");
  } finally {
    await instance.close();
  }
});
