import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../shared/api.ts";
import { member, send, start } from "./support/harness.ts";

const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const blobFiles = (root: string) =>
  readdirSync(join(root, "blobs"), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);

async function trashAndDelete(client: Awaited<ReturnType<typeof member>>, id: string) {
  await client.call(api.items.trash, { params: { id } });
  await client.call(api.items.remove, { params: { id } });
}

test("identical content is stored once and lives until the last item referencing it is purged", async () => {
  const instance = await start();
  try {
    const a = await member(instance, "tia");
    const b = await member(instance, "uma");
    const content = "the same bytes";
    const first = await send(a, [{ path: "one.txt", data: content }]);
    const second = await send(b, [{ path: "two.txt", data: content }]);
    await send(a, [{ path: "other.txt", data: "different" }]);
    assert.deepEqual(blobFiles(instance.root).sort(), [sha(content), sha("different")].sort());
    const path = instance.ctx.blobs.path(sha(content));
    assert.equal(path, join(instance.root, "blobs", sha(content).slice(0, 2), sha(content).slice(2, 4), sha(content)));

    // Quotas count logical bytes per owner even when the payload is shared.
    const used = instance.ctx.db.all<{ username: string; bytes_used: number }>(
      "SELECT username, bytes_used FROM users ORDER BY username",
    );
    assert.deepEqual(
      used.filter((u) => u.username !== "admin").map((u) => u.bytes_used),
      [content.length + 9, content.length],
    );

    await trashAndDelete(a, first.result.itemId);
    assert.equal(existsSync(path), true, "still referenced by the other member's item");
    await trashAndDelete(b, second.result.itemId);
    assert.equal(existsSync(path), false);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM blobs WHERE sha256 = ?", sha(content)), 0);
    assert.deepEqual(blobFiles(instance.root), [sha("different")]);
  } finally {
    await instance.close();
  }
});

test("a held store keeps collected files until the hold is released, unless it was adopted again", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const first = await send(client, [{ path: "a.txt", data: "pinned" }]);
    const path = instance.ctx.blobs.path(sha("pinned"));
    const release = instance.ctx.blobs.hold();
    await trashAndDelete(client, first.result.itemId);
    assert.equal(existsSync(path), true, "pinned");
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM blobs"), 0, "the row is gone at once");
    release();
    assert.equal(existsSync(path), false);

    const again = await send(client, [{ path: "b.txt", data: "pinned" }]);
    const release2 = instance.ctx.blobs.hold();
    await trashAndDelete(client, again.result.itemId);
    await send(client, [{ path: "c.txt", data: "pinned" }]);
    release2();
    assert.equal(existsSync(path), true, "adopted again while pinned");
  } finally {
    await instance.close();
  }
});

test("reconcile removes files without rows and stray thumbnails, and reports rows without files", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    await send(client, [
      { path: "kept.txt", data: "kept" },
      { path: "lost.txt", data: "lost" },
    ]);
    const orphan = "f".repeat(64);
    mkdirSync(join(instance.root, "blobs", "ff", "ff"), { recursive: true });
    writeFileSync(join(instance.root, "blobs", "ff", "ff", orphan), "orphan");
    writeFileSync(join(instance.root, "blobs", "ff", "stray.tmp"), "junk");
    writeFileSync(join(instance.root, "thumbnails", `${orphan}-s.webp`), "x");
    writeFileSync(join(instance.root, "thumbnails", `${sha("kept")}-s.webp`), "x");
    writeFileSync(join(instance.root, "thumbnails", ".interrupted.tmp"), "x");
    unlinkSync(instance.ctx.blobs.path(sha("lost")));

    const result = await instance.ctx.blobs.reconcile();
    assert.deepEqual(result.missing, [sha("lost")]);
    assert.equal(result.removedFiles, 4);
    assert.deepEqual(blobFiles(instance.root), [sha("kept")]);
    assert.deepEqual(readdirSync(join(instance.root, "thumbnails")), [`${sha("kept")}-s.webp`]);
  } finally {
    await instance.close();
  }
});

test("holds cover blobs created later and release only after the last holder", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const firstRelease = instance.ctx.blobs.hold();
    const lastRelease = instance.ctx.blobs.hold();
    const sent = await send(client, [{ path: "later.txt", data: "created while held" }]);
    const file = instance.ctx.blobs.path(sha("created while held"));
    await trashAndDelete(client, sent.result.itemId);
    firstRelease();
    firstRelease();
    assert.equal(existsSync(file), true);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM blobs"), 0);
    lastRelease();
    assert.equal(existsSync(file), false);
  } finally {
    await instance.close();
  }
});
