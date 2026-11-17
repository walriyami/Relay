// The offline reset the hosting control system runs on a stopped Relay (server/control-reset.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../shared/api.ts";
import { expectedObjects } from "../server/db/schema.ts";
import { CLONE_TABLES, CONTENT_TABLES, KEPT_TABLES } from "../server/db/reset.ts";
import { admin, ADMIN_PASSWORD, Client, member, send, start, stop } from "./support/harness.ts";

const reset = (root: string, mode: string) =>
  execFileSync(process.execPath, ["server/control-reset.ts", mode], {
    env: { ...process.env, RELAY_DATA: root },
    encoding: "utf8",
  });

test("every table in schema.sql is either cleared or kept by a content reset, and clone tables are known", () => {
  const tables = expectedObjects(readFileSync("server/db/schema.sql", "utf8"))
    .filter((o) => o.type === "table")
    .map((o) => o.name)
    .sort();
  const listed: string[] = [...CONTENT_TABLES, ...KEPT_TABLES];
  assert.deepEqual([...listed].sort(), tables, "list a new table in server/db/reset.ts");
  assert.equal(new Set(listed).size, listed.length, "a table is both cleared and kept");
  for (const table of CLONE_TABLES) assert.ok(tables.includes(table), table);
});

test("a content reset clears transfers and files but keeps accounts, invitations and their codes", async () => {
  const instance = await start();
  const { root } = instance;
  let restarted: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const owner = await member(instance, "sara");
    const { result } = await send(owner, [{ path: "a.txt", data: "alpha" }]);
    await owner.call(api.links.create, { body: { id: crypto.randomUUID(), item: result.itemId, days: 7 } });
    const boss = await admin(instance);
    const invite = await boss.call(api.admin.invite, { body: { note: "for Omar" } });
    await stop(instance);

    assert.match(reset(root, "--content"), /accounts and settings preserved/);
    assert.deepEqual(readdirSync(join(root, "blobs")), []);

    restarted = await start({}, root);
    const { db } = restarted.ctx;
    assert.equal(db.value("SELECT COUNT(*) FROM items"), 0);
    assert.equal(db.value("SELECT COUNT(*) FROM links"), 0);
    assert.equal(db.value("SELECT bytes_used FROM users WHERE username = 'sara'"), 0);
    // The link's code is retired, never handed out again; the invitation keeps its code.
    assert.equal(db.value("SELECT COUNT(*) FROM pickup_codes WHERE kind = 'share' AND retired IS NULL"), 0);
    assert.equal(db.value("SELECT COUNT(*) FROM pickup_codes WHERE kind = 'share'"), 1);
    const invites = await (await admin(restarted)).call(api.admin.invites);
    assert.equal(invites[0].code, invite.code);
    // Accounts still sign in.
    await new Client(restarted).signIn("sara", "Member-password-only");
  } finally {
    await restarted?.close();
    if (!restarted) await instance.close();
  }
});

test("a clone reset signs everyone out and removes address-bound keys, keeping content", async () => {
  const instance = await start();
  const { root } = instance;
  let restarted: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const owner = await member(instance, "sara");
    await send(owner, [{ path: "a.txt", data: "alpha" }]);
    const device = instance.ctx.db.value<string>("SELECT id FROM devices LIMIT 1")!;
    instance.ctx.db.run(
      "INSERT INTO push_subscriptions(device_id, user_id, endpoint, p256dh, auth, created) SELECT ?, user_id, 'https://fcm.googleapis.com/x', 'k', 'a', 0 FROM devices WHERE id = ?",
      device,
      device,
    );
    await stop(instance);
    // Tests pass the key in configuration; a real install keeps these files in the data folder.
    for (const file of ["secret.key", "setup.key", "push-keys.json"]) writeFileSync(join(root, file), "key\n");

    assert.match(reset(root, "--clone"), /Clone sessions/);
    for (const file of ["secret.key", "setup.key", "push-keys.json"])
      assert.equal(existsSync(join(root, file)), false, file);

    restarted = await start({}, root);
    const { db } = restarted.ctx;
    assert.equal(db.value("SELECT COUNT(*) FROM sessions"), 0);
    assert.equal(db.value("SELECT COUNT(*) FROM push_subscriptions"), 0);
    assert.equal(db.value("SELECT COUNT(*) FROM items"), 1);
    await new Client(restarted).signIn("admin", ADMIN_PASSWORD);
  } finally {
    await restarted?.close();
    if (!restarted) await instance.close();
  }
});

test("the reset refuses to run without a mode", () => {
  assert.throws(() => reset("/nonexistent", "--everything"), /Choose --content or --clone/);
});
