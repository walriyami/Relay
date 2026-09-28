import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { DAY_MS } from "../server/lib/time.ts";
import { autoName } from "../server/modules/library/summary.ts";
import { ApiError, Client, member, openShare, patchUpload, send, start } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};
const summary = async (client: Client, id: string) => client.call(api.items.get, { params: { id } });

test("auto names follow the composer's rule", () => {
  assert.equal(autoName("a.png", 1, null), "a.png");
  assert.equal(autoName("a.png", 1, 2), "a.png + text");
  assert.equal(autoName("a.png", 3, 2), "a.png + 2 more + text");
  assert.equal(autoName("Photos", 2, null), "Photos + 1 more");
  // Text alone is named by its length, never by its content.
  assert.equal(autoName(null, 0, 1), "Text · 1 character");
  assert.equal(autoName(null, 0, 38), "Text · 38 characters");
  assert.equal(autoName(null, 0, 12_345), "Text · 12,345 characters");
  assert.equal(autoName(null, 0, null), null);
});

test("summaries: counts, auto names, previews, mosaics and text excerpts", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const mixed = await send(
      client,
      [
        { path: "a.png", data: "png-a", mime: "image/png" },
        { path: "notes.pdf", data: "pdf", mime: "application/pdf" },
        { path: "deep/b.jpg", data: "jpg-b", mime: "" },
      ],
      { text: "remember this" },
    );
    let s = await summary(client, mixed.result.itemId);
    assert.equal(s.name, "a.png + 2 more + text");
    assert.equal(s.autoName, true);
    assert.deepEqual([s.files, s.texts, s.folders, s.topFiles, s.topFolders], [3, 1, 1, 2, 1]);
    assert.equal(s.bytes, 5 + 3 + 5 + "remember this".length);
    assert.equal(s.preview?.path, "a.png");
    assert.deepEqual(
      s.mosaic.map((m) => m.path),
      ["a.png", "deep/b.jpg"],
    );
    assert.equal(s.textExcerpt, "remember this");
    assert.equal(s.uploading, false);
    assert.equal(s.linked, false);

    const text = await send(client, [], { text: "Wi-Fi: relay-guest\npassword hunter2 ✓!" });
    s = await summary(client, text.result.itemId);
    assert.equal(s.name, "Text · 38 characters", "a text item is never named by its content");
    const listed = await client.call(api.items.list, { query: { q: "hunter2" } });
    assert.ok(!listed.items.some((i) => i.name.includes("hunter2")));
    assert.equal(s.preview?.kind, "text");
    assert.deepEqual(s.mosaic, []);
    assert.equal(s.nodes[0].text, "Wi-Fi: relay-guest\npassword hunter2 ✓!");

    const folder = await send(client, [
      { path: "Photos/x.jpg", data: "x", mime: "image/jpeg" },
      { path: "Photos/y.jpg", data: "y", mime: "image/jpeg" },
    ]);
    s = await summary(client, folder.result.itemId);
    assert.equal(s.name, "Photos");
    assert.deepEqual([s.topFiles, s.topFolders, s.files], [0, 1, 2]);
    assert.equal(s.mosaic.length, 2);

    const single = await send(client, [{ path: "only.png", data: "p", mime: "image/png" }]);
    s = await summary(client, single.result.itemId);
    assert.deepEqual(s.mosaic, [], "one image is a preview, not a mosaic");
    assert.equal(s.preview?.name, "only.png");

    const named = await send(client, [{ path: "q.txt", data: "q" }], { name: "Tax papers" });
    s = await summary(client, named.result.itemId);
    assert.deepEqual([s.name, s.autoName], ["Tax papers", false]);

    // Pending files are invisible; the card reports that something is uploading.
    const pending = await client.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: client.tab,
        name: null,
        folders: [],
        files: [{ path: "slow.bin", size: 10, mime: "" }],
      },
    });
    s = await summary(client, pending.itemId);
    assert.deepEqual([s.files, s.uploading, s.nodes.length, s.name], [0, true, 0, "Uploading…"]);
    await patchUpload(client, pending.uploads[0].id, 0, Buffer.alloc(10));
    s = await summary(client, pending.itemId);
    assert.deepEqual([s.files, s.uploading, s.name], [1, false, "slow.bin"]);
  } finally {
    await instance.close();
  }
});

test("list: library and trash views, search over names and contents, sorting and limits", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const small = await send(client, [{ path: "zebra.txt", data: "z" }]);
    const big = await send(client, [{ path: "docs/Report-2024.pdf", data: "x".repeat(100) }], { name: "Alpha" });
    const trashed = await send(client, [{ path: "old.txt", data: "o" }]);
    await client.call(api.items.trash, { params: { id: trashed.result.itemId } });
    const list = (query: Record<string, unknown> = {}) =>
      client.call(api.items.list, { query }).then((page) => page.items.map((i) => i.id));

    assert.deepEqual(await list(), [big.result.itemId, small.result.itemId]);
    assert.deepEqual(await list({ sort: "old" }), [small.result.itemId, big.result.itemId]);
    assert.deepEqual(await list({ sort: "name" }), [big.result.itemId, small.result.itemId]);
    assert.deepEqual(await list({ sort: "size" }), [big.result.itemId, small.result.itemId]);
    assert.deepEqual(await list({ limit: 1 }), [big.result.itemId]);
    assert.equal((await client.call(api.items.list, { query: { limit: 1 } })).total, 2, "the total counts every match");
    assert.equal((await client.call(api.items.list, { query: { q: "zebra" } })).total, 1);
    const [found] = (await client.call(api.items.list, { query: { q: "report" } })).items;
    assert.deepEqual(found.match, { in: "name", text: "Report-2024.pdf" }, "a match inside the item is named");
    assert.equal((await client.call(api.items.list, { query: { q: "alp" } })).items[0].match, undefined);
    assert.deepEqual(await list({ q: "report-2024" }), [big.result.itemId], "matches a node name");
    assert.deepEqual(await list({ q: "ZEBRA" }), [small.result.itemId], "matches a derived name");
    assert.deepEqual(await list({ q: "alp" }), [big.result.itemId]);
    assert.deepEqual(await list({ view: "trash" }), [trashed.result.itemId]);

    const other = await member(instance, "uma");
    assert.deepEqual(await other.call(api.items.list, { query: { q: "zebra" } }), { items: [], total: 0 });
    assert.equal(await status(other.call(api.items.get, { params: { id: small.result.itemId } })), 404);
  } finally {
    await instance.close();
  }
});

test("library pages stay bounded and reach items beyond the old 10,000-item ceiling", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "large-library");
    const owner = instance.ctx.db.value<string>("SELECT id FROM users WHERE username = ?", "large-library")!;
    const summary = JSON.stringify({
      name: null,
      files: 0,
      texts: 0,
      folders: 0,
      bytes: 0,
      topFiles: 0,
      topFolders: 0,
      preview: null,
      mosaic: [],
      textExcerpt: null,
    });
    instance.ctx.db.run(
      `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 10001)
       INSERT INTO items(id, owner, name, created, summary, summary_dirty)
       SELECT lower(hex(randomblob(16))), ?, printf('scale-%05d', n), n, ?, 0 FROM seq`,
      owner,
      summary,
    );

    const page = await client.call(api.items.list, { query: { limit: 5, offset: 10_000 } });
    assert.equal(page.total, 10_001);
    assert.deepEqual(
      page.items.map((item) => item.name),
      ["scale-00001"],
    );
    assert.equal(await status(client.call(api.items.list, { query: { limit: 201 } })), 400);
  } finally {
    await instance.close();
  }
});

test("bulk item actions authorize every id, reject stale state without partial changes, and preserve lifecycle", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "bulk-owner");
    const first = await send(client, [{ path: "first.txt", data: "a" }], {
      destination: { kind: "link", days: 7 },
    });
    const second = await send(client, [{ path: "second.txt", data: "b" }]);
    const firstId = first.result.itemId;
    const secondId = second.result.itemId;
    const unauthenticated = new Client(instance);

    assert.equal(
      await status(
        client.call(api.items.bulk, {
          body: { operation: "restore", ids: Array.from({ length: 201 }, () => crypto.randomUUID()) },
        }),
      ),
      400,
      "bulk requests cannot exceed one visible page",
    );
    assert.equal(
      await status(unauthenticated.call(api.items.bulk, { body: { operation: "trash", ids: [firstId] } })),
      401,
    );

    const retention = await client.call(api.items.bulk, {
      body: { operation: "retention", ids: [firstId, secondId], retentionDays: 7 },
    });
    assert.deepEqual(retention, { updated: 2 });
    assert.ok((await summary(client, firstId)).expires! > Date.now());
    assert.ok((await summary(client, secondId)).expires! > Date.now());

    const other = await member(instance, "bulk-other");
    const foreign = await send(other, [{ path: "private.txt", data: "p" }]);
    assert.equal(
      await status(
        client.call(api.items.bulk, {
          body: { operation: "trash", ids: [firstId, foreign.result.itemId] },
        }),
      ),
      404,
      "foreign IDs remain indistinguishable from missing items",
    );
    assert.equal(
      (await summary(client, firstId)).trashed,
      null,
      "a foreign ID cannot partially trash the owner's item",
    );

    await client.call(api.items.trash, { params: { id: secondId } });
    assert.equal(
      await status(client.call(api.items.bulk, { body: { operation: "trash", ids: [firstId, secondId] } })),
      409,
      "mixed view state rejects the whole batch",
    );
    assert.equal((await summary(client, firstId)).trashed, null, "the valid row stays untouched after batch rejection");

    const trashed = await client.call(api.items.bulk, { body: { operation: "trash", ids: [firstId] } });
    assert.deepEqual(trashed, { updated: 1 });
    assert.equal((await summary(client, firstId)).linked, false, "bulk trash revokes the existing link");
    const restored = await client.call(api.items.bulk, { body: { operation: "restore", ids: [firstId, secondId] } });
    assert.deepEqual(restored, { updated: 2 });
    assert.equal((await summary(client, firstId)).trashed, null);
    assert.equal(
      (await summary(client, firstId)).expires,
      null,
      "restoring keeps the existing indefinite-retention rule",
    );
    assert.equal((await summary(client, firstId)).linked, false, "restoring does not reactivate revoked links");
  } finally {
    await instance.close();
  }
});

test("trash, restore and delete forever; trashing revokes links and cancels open transfers", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const sent = await send(client, [{ path: "a.txt", data: "a" }], { destination: { kind: "link", days: 7 } });
    const id = sent.result.itemId;
    assert.equal((await summary(client, id)).linked, true);
    assert.equal(await status(client.call(api.items.remove, { params: { id } })), 409, "must be in Trash first");
    assert.equal(await status(client.call(api.items.restore, { params: { id } })), 409, "must be in Trash first");
    assert.equal(
      await status(client.call(api.items.restore, { params: { id: crypto.randomUUID() } })),
      404,
      "unknown items stay private",
    );

    await client.call(api.items.trash, { params: { id } });
    await client.call(api.items.trash, { params: { id } }); // idempotent
    let s = await summary(client, id);
    assert.ok(s.trashed);
    assert.equal(s.linked, false);
    assert.equal(await status(client.call(api.links.open, { params: { token: sent.result.link!.token } })), 410);

    await client.call(api.items.restore, { params: { id } });
    s = await summary(client, id);
    assert.equal(s.trashed, null);
    assert.equal(s.linked, false, "restoring does not un-revoke");
    assert.equal(s.links.length, 0);
    assert.equal(await status(client.call(api.items.restore, { params: { id } })), 409, "already restored");

    // Trashing an item that is still uploading cancels its transfer.
    const open = await client.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: client.tab,
        name: null,
        folders: [],
        files: [{ path: "x.bin", size: 10, mime: "" }],
      },
    });
    await client.call(api.items.trash, { params: { id: open.itemId } });
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", open.id), "cancelled");
    assert.equal((await patchUpload(client, open.uploads[0].id, 0, Buffer.alloc(10))).statusCode, 410);

    await client.call(api.items.trash, { params: { id } });
    await client.call(api.items.remove, { params: { id } });
    assert.equal(await status(client.call(api.items.get, { params: { id } })), 404);
    assert.equal(instance.ctx.db.value("SELECT bytes_used FROM users WHERE username = 'tia'"), 0);
  } finally {
    await instance.close();
  }
});

test("retention: expired items move to Trash, and Trash is purged after 30 days", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const expiring = await send(client, [{ path: "a.txt", data: "a" }]);
    const updated = await client.call(api.items.update, {
      params: { id: expiring.result.itemId },
      body: { retentionDays: 2 },
    });
    assert.ok(updated.expires! > Date.now() + DAY_MS);
    const old = await send(client, [{ path: "b.txt", data: "b" }]);
    await client.call(api.items.trash, { params: { id: old.result.itemId } });

    instance.ctx.db.run("UPDATE items SET expires = ? WHERE id = ?", Date.now() - 1, expiring.result.itemId);
    instance.ctx.db.run(
      "UPDATE items SET trashed = trashed - ?, purge_at = purge_at - ? WHERE id = ?",
      31 * DAY_MS,
      31 * DAY_MS,
      old.result.itemId,
    );
    assert.deepEqual((await client.call(api.items.list)).items, [], "an expired item leaves the library at once");
    await instance.sweep();
    const { items: trash } = await client.call(api.items.list, { query: { view: "trash" } });
    assert.deepEqual(
      trash.map((i) => i.id),
      [expiring.result.itemId],
    );
    assert.equal(await status(client.call(api.items.get, { params: { id: old.result.itemId } })), 404);

    await client.call(api.items.restore, { params: { id: expiring.result.itemId } });
    assert.equal((await summary(client, expiring.result.itemId)).expires, null);
  } finally {
    await instance.close();
  }
});

test("what was sent is immutable: only the item's name and how long it is kept change", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const sent = await send(
      client,
      [
        { path: "Docs/a.txt", data: "a" },
        { path: "c.txt", data: "c" },
      ],
      { name: "Taxes" },
    );
    const itemId = sent.result.itemId;
    const before = await summary(client, itemId);
    const docs = before.nodes.find((n) => n.path === "Docs")!;
    const file = before.nodes.find((n) => n.path === "c.txt")!;
    const other = await send(client, [{ path: "z.txt", data: "z" }]);

    // The routes that used to edit contents are gone, whatever is asked of them.
    const attempts = [
      { method: "PATCH" as const, url: `/api/nodes/${file.id}`, payload: { name: "renamed.txt" } },
      { method: "PATCH" as const, url: `/api/nodes/${docs.id}`, payload: { item: other.result.itemId } },
      { method: "POST" as const, url: `/api/nodes/${file.id}/trash`, payload: {} },
      {
        method: "POST" as const,
        url: `/api/items/${itemId}/folders`,
        payload: { id: crypto.randomUUID(), parent: null, name: "New folder" },
      },
    ];
    for (const attempt of attempts) assert.equal((await client.raw(attempt)).statusCode, 404, attempt.url);

    const renamed = await client.call(api.items.update, {
      params: { id: itemId },
      body: { name: "  2025 taxes  ", retentionDays: 30 },
    });
    assert.equal(renamed.name, "2025 taxes", "the name is trimmed");
    assert.equal(
      (await client.raw({ method: "PATCH", url: `/api/items/${itemId}`, payload: {} })).statusCode,
      400,
      "an empty update is refused",
    );
    assert.equal(
      await status(client.call(api.items.update, { params: { id: itemId }, body: { name: "a/b" } })),
      400,
      "a name is one path segment",
    );

    const after = await summary(client, itemId);
    assert.equal(after.name, "2025 taxes");
    assert.deepEqual(
      after.nodes.map((n) => [n.id, n.path]),
      before.nodes.map((n) => [n.id, n.path]),
    );
    assert.ok(after.expires !== null);

    // Clearing the name goes back to the one derived from the contents.
    const single = other.result.itemId;
    await client.call(api.items.update, { params: { id: single }, body: { name: "Mine" } });
    assert.equal((await summary(client, single)).name, "Mine");
    await client.call(api.items.update, { params: { id: single }, body: { name: null } });
    assert.equal((await summary(client, single)).name, "z.txt");

    // Someone else's item, or one in Trash, can't be renamed.
    const stranger = await member(instance, "una");
    assert.equal(await status(stranger.call(api.items.update, { params: { id: itemId }, body: { name: "X" } })), 404);
    await client.call(api.items.trash, { params: { id: single } });
    assert.equal(await status(client.call(api.items.update, { params: { id: single }, body: { name: "X" } })), 410);
  } finally {
    await instance.close();
  }
});

test("files added to an item join it without changing what is there, and its link shows them", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "ada");
    const sent = await send(client, [{ path: "movie.mkv", data: "big" }], { name: "Trip" });
    const itemId = sent.result.itemId;
    const link = await client.call(api.links.create, { body: { id: crypto.randomUUID(), item: itemId, days: 7 } });
    const before = await summary(client, itemId);

    await send(
      client,
      [
        { path: "movie.mkv", data: "same name" },
        { path: "subs.srt", data: "subtitles" },
      ],
      { item: itemId },
    );
    const after = await summary(client, itemId);
    assert.equal(after.name, "Trip");
    const original = before.nodes[0];
    assert.deepEqual(
      after.nodes.find((n) => n.id === original.id)?.path,
      original.path,
      "what was already there is untouched",
    );
    assert.deepEqual(after.nodes.map((n) => n.path).sort(), ["movie (2).mkv", "movie.mkv", "subs.srt"]);
    const shared = await openShare(new Client(instance), link.token);
    assert.equal(shared.files, 3, "the same link shows the additions");
    assert.equal((await client.call(api.items.list)).total, 1, "no new item was made");

    const stranger = await member(instance, "bea");
    assert.equal(await status(send(stranger, [{ path: "x.txt", data: "x" }], { item: itemId })), 404);
  } finally {
    await instance.close();
  }
});

test("empty Trash deletes every trashed item of the owner and nothing else", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "xia");
    const keep = await send(client, [{ path: "keep.txt", data: "k" }]);
    for (const path of ["one.txt", "two.txt"]) {
      const sent = await send(client, [{ path, data: path }]);
      await client.call(api.items.trash, { params: { id: sent.result.itemId } });
    }
    const other = await member(instance, "yan");
    const theirs = await send(other, [{ path: "theirs.txt", data: "t" }]);
    await other.call(api.items.trash, { params: { id: theirs.result.itemId } });

    assert.deepEqual(await client.call(api.items.emptyTrash), { removed: 2 });
    assert.equal((await client.call(api.items.list, { query: { view: "trash" } })).total, 0);
    assert.deepEqual(
      (await client.call(api.items.list)).items.map((i) => i.id),
      [keep.result.itemId],
    );
    assert.equal((await other.call(api.items.list, { query: { view: "trash" } })).total, 1);
    assert.deepEqual(await client.call(api.items.emptyTrash), { removed: 0 });
  } finally {
    await instance.close();
  }
});
