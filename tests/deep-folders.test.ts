// Folders inside folders: new paths are limited in depth, and trees already stored deeper than
// SQLite's ~1,000-level cascade limit can still be deleted (Trash, Empty Trash, member removal, reset).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { api } from "../shared/api.ts";
import { join } from "node:path";
import { Database } from "../server/db/database.ts";
import { resetContent } from "../server/db/reset.ts";
import { MAX_PATH_DEPTH } from "../server/lib/names.ts";
import { admin, ApiError, Client, member, send, start, stop } from "./support/harness.ts";

/** Deeper than SQLite will cascade a delete. */
const DEEP = 1_100;

const userId = (db: Database, username: string) =>
  db.value<string>("SELECT id FROM users WHERE username = ?", username)!;
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  assert.fail("expected the call to fail");
};
const deepPath = (levels: number) => [...Array<string>(levels - 1).fill("d"), "f.txt"].join("/");

/** Moves an item's only file under a chain of `levels` folders, as data stored before the limit could be. */
function bury(db: Database, itemId: string, levels: number) {
  db.tx(() => {
    const file = db.get<{ id: string; owner: string }>(
      "SELECT id, owner FROM nodes WHERE item = ? AND kind = 'file'",
      itemId,
    )!;
    let parent: string | null = null;
    for (let i = 0; i < levels; i++) {
      const id: string = crypto.randomUUID();
      db.run(
        `INSERT INTO nodes(id, item, owner, parent, name, kind, state, created, position)
         VALUES (?, ?, ?, ?, 'd', 'folder', 'ready', ?, ?)`,
        id,
        itemId,
        file.owner,
        parent,
        Date.now(),
        1000 + i,
      );
      parent = id;
    }
    db.run("UPDATE nodes SET parent = ? WHERE id = ?", parent, file.id);
  });
}

async function deepItem(client: Client, db: Database, data = "hello") {
  const { result } = await send(client, [{ path: "f.txt", data, mime: "text/plain" }]);
  bury(db, result.itemId, DEEP);
  return result.itemId;
}

/** Stops these items' deletion, standing in for any failure the server can meet. */
const keep = (db: Database, ...itemIds: string[]) =>
  db.sqlite.exec(
    `CREATE TEMP TRIGGER keep_item BEFORE DELETE ON items WHEN OLD.id IN (${itemIds.map((id) => `'${id}'`).join(", ")})
     BEGIN SELECT RAISE(ABORT, 'kept for the test'); END`,
  );
const release = (db: Database) => db.sqlite.exec("DROP TRIGGER temp.keep_item");

const stored = (db: Database, username: string) => ({
  bytes: db.value<number>("SELECT bytes_used FROM users WHERE username = ?", username),
  typed: db.value<number>(
    "SELECT ifnull(SUM(bytes), 0) + ifnull(SUM(files), 0) FROM stored_types WHERE owner = (SELECT id FROM users WHERE username = ?)",
    username,
  ),
  nodes: db.value<number>(
    "SELECT COUNT(*) FROM nodes WHERE owner = (SELECT id FROM users WHERE username = ?)",
    username,
  ),
});

test("paths may nest only so many folders deep, for members and request visitors alike", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "nia");
    const create = (paths: { files?: string[]; folders?: string[] }) =>
      client.call(api.transfers.create, {
        body: {
          id: crypto.randomUUID(),
          tab: client.tab,
          name: null,
          folders: paths.folders ?? [],
          files: (paths.files ?? []).map((path) => ({ path, size: 1, mime: "" })),
        },
      });
    await create({ files: [deepPath(MAX_PATH_DEPTH)] });
    for (const tooDeep of [{ files: [deepPath(MAX_PATH_DEPTH + 1)] }, { folders: [deepPath(MAX_PATH_DEPTH + 1)] }]) {
      const error = await failure(create(tooDeep));
      assert.equal(error.status, 400);
      assert.match(error.message, /Something in “d” is nested more than 64 levels deep/);
    }

    const request = await client.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Scans", description: "", days: 1, maxBytes: 100 },
    });
    const visitor = new Client(instance);
    await visitor.call(api.requests.start, { params: { token: request.token } });
    const error = await failure(
      visitor.call(api.requests.transfer, {
        params: { token: request.token },
        body: {
          id: crypto.randomUUID(),
          tab: visitor.tab,
          folders: [],
          files: [{ path: deepPath(MAX_PATH_DEPTH + 1), size: 1, mime: "" }],
        },
      }),
    );
    assert.equal(error.status, 400);
    const owner = userId(instance.ctx.db, "nia");
    assert.equal(
      instance.ctx.db.value(
        "SELECT COUNT(*) FROM nodes WHERE owner = ? AND item NOT IN (SELECT item FROM transfers WHERE principal = ?)",
        owner,
        `user:${owner}`,
      ),
      0,
    );
  } finally {
    await instance.close();
  }
});

test("an item nested deeper than SQLite cascades is deleted from Trash and Empty Trash, keeping usage right", async () => {
  const instance = await start();
  try {
    const { db } = instance.ctx;
    const client = await member(instance, "omar");
    const deep = await deepItem(client, db);
    await client.call(api.items.trash, { params: { id: deep } });
    await client.call(api.items.remove, { params: { id: deep } });
    assert.deepEqual(stored(db, "omar"), { bytes: 0, typed: 0, nodes: 0 });

    // Empty Trash: a deep item goes with the rest.
    const items = [await deepItem(client, db), (await send(client, [{ path: "b.txt", data: "bb" }])).result.itemId];
    for (const id of items) await client.call(api.items.trash, { params: { id } });
    assert.deepEqual(await client.call(api.items.emptyTrash), { removed: 2 });
    assert.deepEqual(stored(db, "omar"), { bytes: 0, typed: 0, nodes: 0 });

    // One item that can't be deleted stays in Trash and is reported; the others still go.
    const stuck = await deepItem(client, db);
    const others = [
      await deepItem(client, db, "x"),
      (await send(client, [{ path: "c.txt", data: "c" }])).result.itemId,
    ];
    for (const id of [stuck, ...others]) await client.call(api.items.trash, { params: { id } });
    keep(db, stuck);
    const error = await failure(client.call(api.items.emptyTrash));
    assert.equal(error.status, 500);
    assert.equal(
      error.message,
      "500 2 items were deleted, but 1 item couldn’t be deleted and is still in Trash. Try again later.",
    );
    assert.deepEqual(
      db.all<{ id: string }>("SELECT id FROM items WHERE owner = ?", userId(db, "omar")).map((r) => r.id),
      [stuck],
      "only the stuck item is left",
    );
    release(db);
    assert.deepEqual(await client.call(api.items.emptyTrash), { removed: 1 });
    assert.deepEqual(stored(db, "omar"), { bytes: 0, typed: 0, nodes: 0 });
  } finally {
    await instance.close();
  }
});

test("removing a member with a deep tree completes; a failed removal leaves them suspended to retry", async () => {
  const instance = await start();
  try {
    const { db } = instance.ctx;
    const boss = await admin(instance);
    const gone = await member(instance, "gone", boss);
    const trashed = await deepItem(gone, db);
    await gone.call(api.items.trash, { params: { id: trashed } });
    const stuck = [await deepItem(gone, db)];
    for (const name of ["a.txt", "b.txt"]) stuck.push((await send(gone, [{ path: name, data: "x" }])).result.itemId);
    const id = userId(db, "gone");
    db.run("UPDATE users SET admin = 1 WHERE id = ?", id);

    keep(db, ...stuck);
    const error = await failure(boss.call(api.admin.removeMember, { params: { id } }));
    assert.equal(
      error.message,
      "500 3 of their items couldn’t be deleted, so gone is suspended but not removed yet. Try removing them again.",
    );
    assert.deepEqual(
      { ...db.get<{ disabled: number; admin: number }>("SELECT disabled, admin FROM users WHERE id = ?", id) },
      { disabled: 1, admin: 0 },
      "suspended, not half-removed, and no longer counted as an administrator",
    );
    assert.equal(db.value("SELECT COUNT(*) FROM history WHERE kind = 'suspended'"), 1, "History says what happened");
    assert.deepEqual(
      db.all<{ id: string }>("SELECT id FROM items WHERE owner = ? ORDER BY id", id).map((r) => r.id),
      stuck.sort(),
      "everything else was deleted",
    );
    // The members list says the removal stopped, so it can be finished later.
    const listed = async () =>
      (await boss.call(api.admin.overview)).members.find((m) => m.id === id)?.removalStopped ?? null;
    assert.ok(await listed());
    // Suspending them again keeps it; lifting the suspension lets the removal go.
    await boss.call(api.admin.updateMember, { params: { id }, body: { disabled: true } });
    assert.ok(await listed());
    await boss.call(api.admin.updateMember, { params: { id }, body: { disabled: false } });
    assert.equal(await listed(), null);

    release(db);
    // A second click while the first removal is still deleting is turned away, not run twice.
    const clicks = await Promise.allSettled([0, 1].map(() => boss.call(api.admin.removeMember, { params: { id } })));
    assert.deepEqual(
      clicks.map((c) => (c.status === "fulfilled" ? 200 : (c.reason as ApiError).status)).sort(),
      [200, 409],
    );
    assert.equal(db.value("SELECT COUNT(*) FROM users WHERE id = ?", id), 0);
    assert.equal(db.value("SELECT COUNT(*) FROM nodes WHERE owner = ?", id), 0);
    assert.equal(db.value("SELECT COUNT(*) FROM history WHERE kind = 'removed'"), 1, "recorded once");
  } finally {
    await instance.close();
  }
});

test("a content reset clears a tree deeper than SQLite cascades", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "rae");
    await deepItem(client, instance.ctx.db);
    await stop(instance);
    resetContent(instance.root);
    const db = new Database(join(instance.root, "relay.sqlite"));
    try {
      assert.equal(db.value("SELECT COUNT(*) FROM nodes"), 0);
      assert.equal(db.value("SELECT bytes_used FROM users WHERE username = 'rae'"), 0);
    } finally {
      db.close();
    }
  } finally {
    await instance.close().catch(() => {});
    await rm(instance.root, { recursive: true, force: true });
  }
});
