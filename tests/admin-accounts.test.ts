import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, urls } from "../shared/api.ts";
import { NO_LIMITS } from "../shared/model.ts";
import { issueRecovery } from "../server/modules/recovery/index.ts";
import { ADMIN_PASSWORD, admin, ApiError, Client, member, send, start } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

/** Names and contents of every member of an archive, read with Python's zipfile (CRCs checked). */
function unzip(zip: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), "relay-export-"));
  try {
    const file = join(dir, "archive.zip");
    writeFileSync(file, zip);
    const script = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None
    print(json.dumps({i.filename: (None if i.is_dir() else z.read(i).decode("utf-8")) for i in z.infolist()}))`;
    return JSON.parse(execFileSync("python3", ["-c", script, file]).toString()) as Record<string, string | null>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("administrators can make another member an administrator and take the role back, never leaving none", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const bossId = (await boss.call(api.session.get)).user.id;
    const maya = await member(instance, "maya", boss);
    const mayaId = (await maya.call(api.session.get)).user.id;
    const limits = { storage: 5000, keepDays: 7, linkDays: 3 };
    await boss.call(api.admin.updateMember, { params: { id: mayaId }, body: { limits, expectedLimits: NO_LIMITS } });

    assert.equal(
      await status(boss.call(api.admin.updateMember, { params: { id: bossId }, body: { admin: false } })),
      409,
      "the only administrator keeps the role",
    );

    await boss.call(api.admin.updateMember, { params: { id: mayaId }, body: { admin: true } });
    const promoted = await maya.call(api.session.get);
    assert.equal(promoted.user.admin, true, "the role applies to the existing session at once");
    assert.deepEqual(promoted.user.limits, NO_LIMITS, "administrators have no limits");
    assert.equal((await maya.call(api.admin.overview)).members.filter((m) => m.admin).length, 2);
    assert.equal(
      await status(boss.call(api.admin.updateMember, { params: { id: mayaId }, body: { disabled: true } })),
      409,
      "an administrator cannot be disabled",
    );

    // With two administrators, one may step down, even themselves.
    await boss.call(api.admin.updateMember, { params: { id: bossId }, body: { admin: false } });
    assert.equal(await status(boss.call(api.admin.overview)), 403, "the role is gone at once");
    assert.equal(
      await status(maya.call(api.admin.updateMember, { params: { id: mayaId }, body: { admin: false } })),
      409,
      "the last administrator cannot step down",
    );

    // A disabled account must be turned back on before it can be made an administrator.
    await maya.call(api.admin.updateMember, { params: { id: bossId }, body: { disabled: true } });
    assert.equal(
      await status(maya.call(api.admin.updateMember, { params: { id: bossId }, body: { admin: true } })),
      409,
    );
    await maya.call(api.admin.updateMember, { params: { id: bossId }, body: { disabled: false, admin: true } });
    await new Client(instance).signIn("admin", ADMIN_PASSWORD);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM users WHERE admin = 1"), 2);
  } finally {
    await instance.close();
  }
});

test("removing a member says what goes, then deletes their files, links and sign-ins and frees the space", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const bossId = (await boss.call(api.session.get)).user.id;
    const keep = await member(instance, "keep", boss);
    const kept = await send(keep, [{ path: "shared-bytes.bin", data: "same bytes" }]);
    const gone = await member(instance, "gone", boss);
    const goneId = (await gone.call(api.session.get)).user.id;
    await send(gone, [{ path: "shared-bytes.bin", data: "same bytes" }]);
    const linked = await send(gone, [{ path: "own.bin", data: Buffer.alloc(400, 7) }], {
      destination: { kind: "link", days: 1 },
    });
    const trashed = await send(gone, [{ path: "old.bin", data: Buffer.alloc(100, 9) }]);
    await gone.call(api.items.trash, { params: { id: trashed.created.itemId } });
    await gone.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Photos please", description: "", days: 1, maxBytes: 1024 },
    });
    const usedBefore = (await boss.call(api.admin.overview)).storage.used;

    const preview = await boss.call(api.admin.removal, { params: { id: goneId } });
    assert.deepEqual(preview, { items: 3, bytes: 510, links: 1, requests: 1, devices: 1 });

    assert.equal(
      await status(boss.call(api.admin.removeMember, { params: { id: bossId } })),
      409,
      "nobody removes their own account",
    );
    assert.equal(await status(boss.call(api.admin.removeMember, { params: { id: crypto.randomUUID() } })), 404);

    await boss.call(api.admin.removeMember, { params: { id: goneId } });
    assert.equal(await status(gone.call(api.session.get)), 401, "the removed member is signed out");
    assert.equal(await status(new Client(instance).signIn("gone", "Member-password-only")), 401);
    const after = await boss.call(api.admin.overview);
    assert.deepEqual(
      after.members.map((m) => m.username),
      ["admin", "keep"],
    );
    assert.equal(after.storage.used, usedBefore - 510, "their space is free again");
    for (const table of ["items", "nodes", "links", "requests", "devices", "sessions"])
      assert.equal(
        instance.ctx.db.value(
          `SELECT COUNT(*) FROM ${table} WHERE ${table === "devices" || table === "sessions" ? "user_id" : "owner"} = ?`,
          goneId,
        ),
        0,
        table,
      );
    const visitor = new Client(instance);
    assert.equal(await status(visitor.call(api.links.open, { params: { token: linked.result.link!.token } })), 404);
    // Bytes another member also stored are kept for them.
    const keptNode = (await keep.call(api.items.get, { params: { id: kept.created.itemId } })).nodes[0];
    assert.equal((await keep.raw({ method: "GET", url: urls.nodeContent(keptNode.id) })).body, "same bytes");
    await instance.ctx.blobs.drain();
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM blobs"), 1, "unshared blobs are deleted");
  } finally {
    await instance.close();
  }
});

test("another administrator can be removed, but never the last one", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const bossId = (await boss.call(api.session.get)).user.id;
    const second = await member(instance, "second", boss);
    const secondId = (await second.call(api.session.get)).user.id;
    await boss.call(api.admin.updateMember, { params: { id: secondId }, body: { admin: true } });
    await second.call(api.admin.removeMember, { params: { id: bossId } });
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM users WHERE admin = 1"), 1);
    assert.equal(await status(boss.call(api.session.get)), 401);
    assert.equal(await status(second.call(api.admin.removeMember, { params: { id: secondId } })), 409);
  } finally {
    await instance.close();
  }
});

test("outsiders and members cannot see or remove accounts", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const plain = await member(instance, "plain", boss);
    const bossId = (await boss.call(api.session.get)).user.id;
    const anonymous = new Client(instance);
    for (const client of [anonymous, plain]) {
      const expected = client === anonymous ? 401 : 403;
      assert.equal(await status(client.call(api.admin.removal, { params: { id: bossId } })), expected);
      assert.equal(await status(client.call(api.admin.removeMember, { params: { id: bossId } })), expected);
      assert.equal(
        await status(client.call(api.admin.updateMember, { params: { id: bossId }, body: { admin: false } })),
        expected,
      );
    }
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM users"), 2);
  } finally {
    await instance.close();
  }
});

test("the owner's recovery link sets a new administrator password once", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const bossId = (await boss.call(api.session.get)).user.id;
    await member(instance, "helper", boss);
    instance.ctx.db.run(
      "INSERT INTO passkeys(id, user_id, public_key, counter, transports, name, created) VALUES(?, ?, ?, ?, ?, ?, ?)",
      "lost-passkey",
      bossId,
      Buffer.from([1]),
      0,
      "[]",
      "Lost key",
      Date.now(),
    );

    instance.ctx.config.recoverAdmin = "helper";
    assert.equal(issueRecovery(instance.ctx)?.link, undefined, "only an administrator can be recovered");

    instance.ctx.config.recoverAdmin = "Admin";
    const issued = issueRecovery(instance.ctx)!;
    const token = issued.link!.split("#")[1];
    assert.match(issued.link!, /\/recover#[A-Za-z0-9_-]{43}$/);
    const replaced = issueRecovery(instance.ctx)!.link!.split("#")[1];
    const stranger = new Client(instance);
    assert.equal(await status(stranger.call(api.recovery.check, { body: { token } })), 410, "a restart replaces it");
    assert.equal(await status(stranger.call(api.recovery.reset, { body: { token, password: "Not-this-one-1" } })), 410);

    assert.deepEqual(Object.keys(await stranger.call(api.recovery.check, { body: { token: replaced } })).sort(), [
      "expires",
      "username",
    ]);
    assert.equal((await stranger.call(api.recovery.check, { body: { token: replaced } })).username, "admin");
    await stranger.call(api.recovery.reset, { body: { token: replaced, password: "Recovered-password-1" } });
    assert.equal(await status(boss.call(api.session.get)), 401, "every session ends");
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM passkeys WHERE user_id = ?", bossId), 0);
    assert.equal(await status(new Client(instance).signIn("admin", ADMIN_PASSWORD)), 401);
    await new Client(instance).signIn("admin", "Recovered-password-1");
    assert.equal(
      await status(stranger.call(api.recovery.reset, { body: { token: replaced, password: "Again-and-again-1" } })),
      410,
      "the link works once",
    );

    const restarted = issueRecovery(instance.ctx)!;
    assert.equal(restarted.link, undefined, "a used setting does not issue another link");
    assert.match(restarted.message, /Clear RELAY_RECOVER_ADMIN/);
    instance.ctx.config.recoverAdmin = undefined;
    assert.equal(issueRecovery(instance.ctx), undefined);
    instance.ctx.config.recoverAdmin = "admin";
    assert.ok(issueRecovery(instance.ctx)?.link, "clearing the setting allows a later recovery");
    instance.ctx.config.recoverAdmin = undefined;
    issueRecovery(instance.ctx);
    assert.equal(instance.ctx.db.setting("recovery"), undefined, "clearing the setting ends an open link");
  } finally {
    await instance.close();
  }
});

test("Storage shows a member their space, Trash and largest items, and nobody else's", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const ana = await member(instance, "ana", boss);
    const anaId = (await ana.call(api.session.get)).user.id;
    await boss.call(api.admin.updateMember, {
      params: { id: anaId },
      body: { limits: { storage: 10_000, keepDays: null, linkDays: null }, expectedLimits: NO_LIMITS },
    });
    const big = await send(ana, [{ path: "big.bin", data: Buffer.alloc(3000, 1) }]);
    await send(ana, [{ path: "small.bin", data: Buffer.alloc(200, 2) }]);
    const old = await send(ana, [{ path: "old.bin", data: Buffer.alloc(700, 3) }]);
    await ana.call(api.items.trash, { params: { id: old.created.itemId } });
    await send(boss, [{ path: "boss.bin", data: Buffer.alloc(9000, 4) }]);

    const storage = await ana.call(api.storage);
    assert.equal(storage.used, 3900);
    assert.equal(storage.limit, 10_000);
    assert.equal(storage.available, 6100);
    assert.deepEqual(storage.trash, { items: 1, bytes: 700 });
    assert.equal(storage.items, 2);
    assert.deepEqual(
      storage.largest.map((item) => [item.id, item.name, item.bytes]),
      [
        [big.created.itemId, "big.bin", 3000],
        [storage.largest[1].id, "small.bin", 200],
      ],
    );
    assert.equal(await status(new Client(instance).call(api.storage)), 401);
  } finally {
    await instance.close();
  }
});

test("a member can download all their files as one ZIP, and only their own", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const ana = await member(instance, "ana", boss);
    await send(ana, [{ path: "report.pdf", data: "first report" }]);
    await send(ana, [{ path: "report.pdf", data: "second report" }]);
    await send(
      ana,
      [
        { path: "Trip/day1.jpg", data: "day one" },
        { path: "Trip/day2.jpg", data: "day two" },
      ],
      {},
    );
    await send(
      ana,
      [
        { path: "a.txt", data: "a" },
        { path: "b.txt", data: "b" },
      ],
      { name: "Two files" },
    );
    await send(ana, [], { text: "a note" });
    const trashed = await send(ana, [{ path: "binned.txt", data: "binned" }]);
    await ana.call(api.items.trash, { params: { id: trashed.created.itemId } });
    await send(boss, [{ path: "boss.txt", data: "not yours" }]);

    const res = await ana.raw({ method: "GET", url: urls.exportZip() });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["content-type"], "application/zip");
    assert.match(
      decodeURIComponent(String(res.headers["content-disposition"])),
      /^attachment; .*Relay - ana - \d{4}-\d{2}-\d{2}\.zip$/,
    );
    assert.equal(Number(res.headers["content-length"]), res.rawPayload.length);
    assert.deepEqual(unzip(res.rawPayload), {
      "Text.txt": "a note",
      "Trip/": null,
      "Trip/day1.jpg": "day one",
      "Trip/day2.jpg": "day two",
      "Two files/": null,
      "Two files/a.txt": "a",
      "Two files/b.txt": "b",
      "report (2).pdf": "second report",
      "report.pdf": "first report",
    });
    const head = await ana.raw({ method: "HEAD", url: urls.exportZip() });
    assert.equal(head.headers["content-length"], res.headers["content-length"]);

    assert.equal((await new Client(instance).raw({ method: "GET", url: urls.exportZip() })).statusCode, 401);
    const empty = await member(instance, "empty", boss);
    const nothing = await empty.raw({ method: "GET", url: urls.exportZip() });
    assert.equal(nothing.statusCode, 404);
    assert.match(nothing.json<{ error: string }>().error, /no files/);
  } finally {
    await instance.close();
  }
});
