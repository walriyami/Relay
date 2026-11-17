// A page that sleeps, reloads or closes leaves its uploads paused; the same page or a new one continues them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { api, headers, urls } from "../shared/api.ts";
import type { PausedTransfer } from "../shared/model.ts";
import { ApiError, Client, member, patchUpload, start } from "./support/harness.ts";

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

/** Another page load in the same browser: same cookies, its own tab id. */
function reload(client: Client) {
  const page = new Client(client.instance);
  for (const [k, v] of client.cookies) page.cookies.set(k, v);
  page.csrf = client.csrf;
  return page;
}

/** A PATCH that names its page, as the app's pages do. */
const patchFrom = (client: Client, upload: string, offset: number, data: Buffer) =>
  client.raw({
    method: "PATCH",
    url: urls.upload(upload),
    headers: {
      "tus-resumable": "1.0.0",
      "upload-offset": String(offset),
      "content-type": "application/offset+octet-stream",
      [headers.tab]: client.tab,
    },
    payload: data,
  });

const listPaused = (client: Client) =>
  client.raw({ method: "GET", url: api.transfers.paused.path, headers: { [headers.tab]: client.tab } }).then((r) => {
    assert.equal(r.statusCode, 200, r.body);
    return r.json<PausedTransfer[]>();
  });

async function startTransfer(client: Client, data: Buffer) {
  const created = await client.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: client.tab,
      name: null,
      folders: [],
      text: "notes",
      files: [
        { path: "Trip/done.txt", size: 4, mime: "text/plain" },
        { path: "Trip/video.bin", size: data.length, mime: "" },
      ],
    },
  });
  assert.equal((await patchFrom(client, created.uploads[0].id, 0, Buffer.from("done"))).statusCode, 204);
  assert.equal((await patchFrom(client, created.uploads[1].id, 0, data.subarray(0, 6000))).statusCode, 204);
  return created;
}

test("a page that slept past its lease keeps its upload and continues it on waking", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const data = Buffer.alloc(9000, 7);
    const created = await startTransfer(client, data);
    // The phone slept: nothing renewed the page's lease for longer than it lasts.
    const slept = Date.now() + 2 * instance.ctx.config.tabLeaseMs;
    instance.ctx.db.run("UPDATE tabs SET lease_expires = ? WHERE id = ?", Date.now() - 1, client.tab);
    await instance.ctx.transfers.sweep(slept);
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", created.id), "open");
    // Woken, the same page asks where it got to and sends the rest.
    const head = await client.raw({
      method: "HEAD",
      url: urls.upload(created.uploads[1].id),
      headers: { "tus-resumable": "1.0.0", [headers.tab]: client.tab },
    });
    assert.equal(head.headers["upload-offset"], "6000");
    assert.equal((await patchFrom(client, created.uploads[1].id, 6000, data.subarray(6000))).statusCode, 204);
    await client.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });
    const item = await client.call(api.items.get, { params: { id: created.itemId } });
    assert.ok(item.nodes.some((n) => n.name === "video.bin" && n.size === 9000));
  } finally {
    await instance.close();
  }
});

test("a reloaded page lists the paused upload, checks the file, continues it, and the old page is refused", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const data = Buffer.from(Array.from({ length: 9000 }, (_, i) => i % 251));
    const created = await startTransfer(client, data);
    await client.call(api.transfers.closeTab, { params: { id: client.tab } });
    const page = reload(client);

    const [paused] = await listPaused(page);
    assert.equal(paused.id, created.id);
    assert.equal(paused.itemId, created.itemId);
    assert.equal(paused.name, "Trip");
    assert.equal(paused.adding, false);
    assert.equal(paused.text, true);
    assert.ok(paused.keptUntil >= Date.now() + instance.ctx.config.pausedUploadMs - 60_000);
    assert.deepEqual(
      paused.files.map(({ path, size, offset, done }) => ({ path, size, offset, done })),
      [
        { path: "Trip/done.txt", size: 4, offset: 4, done: true },
        { path: "Trip/video.bin", size: 9000, offset: 6000, done: false },
      ],
    );
    const sample = paused.files[1].sample!;
    assert.deepEqual(Buffer.from(sample.head, "base64"), data.subarray(0, 4096));
    assert.deepEqual(Buffer.from(sample.tail, "base64"), data.subarray(6000 - 4096, 6000));
    assert.equal(paused.files[0].sample, undefined);

    // The paused list leaves out what the asking page itself is sending.
    await page.call(api.transfers.resume, { params: { id: created.id }, body: { tab: page.tab } });
    assert.deepEqual(await listPaused(page), []);
    const late = await patchFrom(client, created.uploads[1].id, 6000, data.subarray(6000));
    assert.equal(late.statusCode, 409);
    assert.match(late.json<{ error: string }>().error, /another page/);
    assert.equal((await patchFrom(page, created.uploads[1].id, 6000, data.subarray(6000))).statusCode, 204);
    await page.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });
    const blob = instance.ctx.db.value<string>(
      "SELECT blob FROM nodes WHERE item = ? AND name = 'video.bin'",
      created.itemId,
    );
    assert.equal(blob, createHash("sha256").update(data).digest("hex"));
  } finally {
    await instance.close();
  }
});

test("paused uploads are removed only after pausedUploadMs, and are then honestly reported", async () => {
  const instance = await start({ pausedUploadMs: 60_000 });
  try {
    const client = await member(instance, "tia");
    const created = await startTransfer(client, Buffer.alloc(9000));
    await client.call(api.transfers.closeTab, { params: { id: client.tab } });
    const closed = instance.ctx.db.value<number>("SELECT closed FROM tabs WHERE id = ?", client.tab)!;
    await instance.ctx.transfers.sweep(closed + 59_999);
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", created.id), "open");
    await instance.ctx.transfers.sweep(closed + 60_000);
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", created.id), "cancelled");
    const page = reload(client);
    assert.deepEqual(await listPaused(page), []);
    // The text and the finished file were kept; the unfinished one is gone.
    const item = await page.call(api.items.get, { params: { id: created.itemId } });
    assert.deepEqual(item.nodes.filter((n) => n.kind === "file").map((n) => n.name), ["done.txt"]);
    let message = "";
    try {
      await page.call(api.transfers.resume, { params: { id: created.id }, body: { tab: page.tab } });
    } catch (error) {
      assert.equal((error as ApiError).status, 410);
      message = (error as ApiError).message;
    }
    assert.match(message, /stopped, and its unfinished files were removed/);
  } finally {
    await instance.close();
  }
});

test("outsiders can neither see nor continue someone else's paused upload", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const created = await startTransfer(client, Buffer.alloc(9000));
    await client.call(api.transfers.closeTab, { params: { id: client.tab } });

    const other = await member(instance, "uma");
    assert.deepEqual(await listPaused(other), []);
    assert.equal(
      await status(other.call(api.transfers.resume, { params: { id: created.id }, body: { tab: other.tab } })),
      404,
    );
    const anonymous = new Client(instance);
    assert.equal(await status(anonymous.call(api.transfers.paused)), 401);
    assert.equal(
      await status(anonymous.call(api.transfers.resume, { params: { id: created.id }, body: { tab: anonymous.tab } })),
      401,
    );
    // A guest of tia's request is no member: both routes refuse it.
    const request = await client.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Drop", description: "", days: 7, maxBytes: 1000 },
    });
    const guest = new Client(instance);
    guest.csrf = (await guest.call(api.requests.start, { params: { token: request.token } })).csrf;
    assert.equal(await status(guest.call(api.transfers.paused)), 401);
    assert.equal(
      await status(guest.call(api.transfers.resume, { params: { id: created.id }, body: { tab: guest.tab } })),
      403, // a guest's token never passes a member-only route's CSRF check
    );
    // A page cannot take over a transfer into a page id that was already closed.
    assert.equal(
      await status(client.call(api.transfers.resume, { params: { id: created.id }, body: { tab: client.tab } })),
      409,
    );
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", created.id), "open");
  } finally {
    await instance.close();
  }
});

test("a finished transfer cannot be resumed", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const created = await client.call(api.transfers.create, {
      body: { id: crypto.randomUUID(), tab: client.tab, name: null, folders: [], files: [{ path: "a.txt", size: 1, mime: "" }] },
    });
    await patchUpload(client, created.uploads[0].id, 0, Buffer.from("a"));
    await client.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });
    const page = reload(client);
    assert.equal(
      await status(page.call(api.transfers.resume, { params: { id: created.id }, body: { tab: page.tab } })),
      409,
    );
  } finally {
    await instance.close();
  }
});
