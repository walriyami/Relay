// The room checks a request-link visitor can trigger (the request page, every MiB they send) read
// totals the database triggers keep, instead of adding up every unfinished upload on the server.
// These tests hold the totals to the sums they replace, through every way an upload ends, and make
// sure the checks never go back to reading every upload.
import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../shared/api.ts";
import { Client, admin, member, patchUpload, start, stop, type Instance } from "./support/harness.ts";
import {
  heldBytes,
  outstandingBytes,
  quotaRoom,
  ensureVisitorRoom,
  visitorStorageRoom,
} from "../server/modules/transfers/room.ts";
import { room } from "../server/modules/requests/guests.ts";

/** The sums the totals replace, worked out the slow way from every row. */
function reference(instance: Instance) {
  const { db } = instance.ctx;
  const from = `FROM nodes n LEFT JOIN uploads u ON u.node = n.id LEFT JOIN transfers t ON t.id = u.transfer
    WHERE n.state = 'pending'`;
  const unsent = (visitors: boolean) =>
    db.value<number>(
      `SELECT coalesce(sum(${visitors ? "u.size - u.offset" : "CASE WHEN t.principal LIKE 'grant:%' THEN 0 ELSE u.size - u.offset END"}), 0)
       FROM uploads u JOIN transfers t ON t.id = u.transfer
       WHERE u.completed IS NULL AND u.node IS NOT NULL AND t.state = 'open'`,
    )!;
  return {
    heldVisitors: db.value<number>(`SELECT coalesce(sum(n.size), 0) ${from}`)!,
    heldMembers: db.value<number>(
      `SELECT coalesce(sum(CASE WHEN t.principal LIKE 'grant:%' THEN u.offset ELSE n.size END), 0) ${from}`,
    )!,
    unsentAll: unsent(true),
    unsentMembers: unsent(false),
    reserved: db.all<{ id: string; bytes: number }>(
      `SELECT u.id, (SELECT coalesce(sum(size), 0) FROM nodes WHERE owner = u.id AND state = 'pending') AS bytes
       FROM users u ORDER BY u.id`,
    ),
    requests: db.all<{ id: string; entries: number; bytes: number }>(
      `SELECT r.id, count(n.id) AS entries, coalesce(sum(n.size), 0) AS bytes FROM requests r
       LEFT JOIN items i ON i.request_id = r.id LEFT JOIN nodes n ON n.item = i.id GROUP BY r.id ORDER BY r.id`,
    ),
  };
}

/** The same figures, from the totals. */
function kept(instance: Instance) {
  const { ctx } = instance;
  return {
    heldVisitors: heldBytes(ctx, true),
    heldMembers: heldBytes(ctx, false),
    unsentAll: outstandingBytes(ctx, true),
    unsentMembers: outstandingBytes(ctx, false),
    reserved: ctx.db.all<{ id: string; bytes: number }>("SELECT id, reserved_bytes AS bytes FROM users ORDER BY id"),
    requests: ctx.db.all<{ id: string; entries: number; bytes: number }>(
      "SELECT id, held_entries AS entries, held_bytes AS bytes FROM requests ORDER BY id",
    ),
  };
}

const same = (instance: Instance, step: string) =>
  assert.deepEqual(
    JSON.parse(JSON.stringify(kept(instance))),
    JSON.parse(JSON.stringify(reference(instance))),
    `after ${step}`,
  );

const files = (names: string[], size = 10) => names.map((path) => ({ path, size, mime: "" }));

async function visitorSend(instance: Instance, token: string, names: string[], address: string) {
  const visitor = new Client(instance);
  visitor.address = address;
  await visitor.call(api.requests.start, { params: { token } });
  const created = await visitor.call(api.requests.transfer, {
    params: { token },
    body: { id: crypto.randomUUID(), tab: visitor.tab, folders: [], files: files(names) },
  });
  return { visitor, created };
}

test("the totals match every unfinished upload, however each one ends, and after a restart", async () => {
  let instance = await start();
  const root = instance.root;
  try {
    const owner = await member(instance, "owner");
    const other = await member(instance, "other");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Scans", description: "", days: 5, maxBytes: 1024 ** 2 },
    });
    same(instance, "nothing");

    const mine = await owner.call(api.transfers.create, {
      body: { id: crypto.randomUUID(), tab: owner.tab, name: null, folders: ["empty"], files: files(["a", "b", "c"]) },
    });
    await other.call(api.transfers.create, {
      body: { id: crypto.randomUUID(), tab: other.tab, name: null, folders: [], files: files(["x", "y"]) },
    });
    const one = await visitorSend(instance, request.token, ["v1", "v2", "v3"], "192.0.2.1");
    const two = await visitorSend(instance, request.token, ["w1", "w2"], "192.0.2.2");
    same(instance, "creating");

    // Part of a file, then a whole one, from a member and from visitors.
    assert.equal((await patchUpload(owner, mine.uploads[0].id, 0, Buffer.alloc(4))).statusCode, 204);
    assert.equal((await patchUpload(one.visitor, one.created.uploads[0].id, 0, Buffer.alloc(3))).statusCode, 204);
    assert.equal((await patchUpload(one.visitor, one.created.uploads[1].id, 0, Buffer.alloc(10))).statusCode, 204);
    assert.equal((await patchUpload(owner, mine.uploads[1].id, 0, Buffer.alloc(10))).statusCode, 204);
    same(instance, "uploading");

    // Skipping a file, finishing a transfer, cancelling one.
    await one.visitor.call(api.transfers.removeUpload, { params: { id: one.created.uploads[2].id } });
    assert.equal((await patchUpload(one.visitor, one.created.uploads[0].id, 3, Buffer.alloc(7))).statusCode, 204);
    await one.visitor.call(api.transfers.complete, {
      params: { id: one.created.id },
      body: { destination: { kind: "save" } },
    });
    await two.visitor.call(api.transfers.cancel, { params: { id: two.created.id } });
    same(instance, "skipping, finishing and cancelling");

    // The owner leaves their page (paused), a visitor's page goes (abandoned), and the sweep runs.
    const three = await visitorSend(instance, request.token, ["z1"], "192.0.2.3");
    assert.equal((await patchUpload(three.visitor, three.created.uploads[0].id, 0, Buffer.alloc(5))).statusCode, 204);
    await three.visitor.call(api.transfers.closeTab, { params: { id: three.visitor.tab } });
    await instance.ctx.transfers.sweep(Date.now() + 2 * 24 * 3600_000);
    same(instance, "closing pages and sweeping");

    // A restart keeps them, and corrects totals that went wrong (or columns new to the database).
    instance.ctx.db.run(
      "UPDATE users SET reserved_bytes = 7, reserved_visitor_unsent = 7, unsent_member = 7, unsent_visitor = 7",
    );
    instance.ctx.db.run("UPDATE requests SET held_entries = 7, held_bytes = 7");
    await stop(instance);
    instance = await start({}, root);
    assert.ok(instance.ctx.db.correctedHeldTotals > 0);
    same(instance, "a restart");

    // Deleting what holds them: the owner's item in Trash, the request, a whole member.
    const owner2 = new Client(instance);
    await owner2.signIn("owner", "Member-password-only");
    const items = await owner2.call(api.items.list);
    for (const item of items.items) await owner2.call(api.items.trash, { params: { id: item.id } });
    await owner2.call(api.items.emptyTrash);
    same(instance, "emptying Trash");
    await owner2.call(api.requests.close, { params: { id: request.id } });
    same(instance, "closing the request");
    const boss = await admin(instance);
    const otherId = instance.ctx.db.value<string>("SELECT id FROM users WHERE username = 'other'")!;
    await boss.call(api.admin.removeMember, { params: { id: otherId } });
    same(instance, "removing a member");
  } finally {
    await instance.close();
  }
});

/** Records every statement Relay prepares while `work` runs. */
function statements(instance: Instance, work: () => void) {
  const db = instance.ctx.db as unknown as { prepare(sql: string): unknown };
  const prepare = db.prepare.bind(db);
  const seen = new Set<string>();
  db.prepare = (sql: string) => (seen.add(sql), prepare(sql));
  try {
    work();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}

test("a visitor's page and their per-MiB check read single rows, not every upload or file", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Scans", description: "", days: 5, maxBytes: 1024 ** 2 },
    });
    const { visitor, created } = await visitorSend(instance, request.token, ["a", "b", "c"], "192.0.2.1");
    assert.equal((await patchUpload(visitor, created.uploads[0].id, 0, Buffer.alloc(4))).statusCode, 204);
    const ownerId = instance.ctx.db.value<string>("SELECT owner FROM requests WHERE id = ?", request.id)!;
    const upload = { id: created.uploads[1].id, size: 10, offset: 0 };
    const seen = statements(instance, () => {
      room(instance.ctx, { id: request.id, max_bytes: 1024 ** 2 });
      visitorStorageRoom(instance.ctx, ownerId);
      quotaRoom(instance.ctx, ownerId);
      ensureVisitorRoom(instance.ctx, upload);
      heldBytes(instance.ctx, false, upload.id);
    });
    assert.ok(seen.size >= 3);
    const { sqlite } = instance.ctx.db;
    const scans: string[] = [];
    for (const sql of seen)
      for (const row of sqlite
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null)))
        // One row each, found by its id: never a scan, nor a range of a request's or a member's files.
        if (
          /^(SCAN|SEARCH) (nodes|n|uploads|u|transfers|t|items|i)\b/.test(String(row.detail)) &&
          !/USING ((COVERING )?INDEX sqlite_autoindex_\w+|PRIMARY KEY) \(id=\?\)$/.test(String(row.detail))
        )
          scans.push(`${String(row.detail)} <- ${sql.replace(/\s+/g, " ")}`);
    assert.deepEqual(scans, []);
  } finally {
    await instance.close();
  }
});
