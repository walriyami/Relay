import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { api } from "../shared/api.ts";
import type { ItemRow, TransferInput } from "../server/context.ts";
import { memberFromToken } from "../server/lib/auth.ts";
import { DAY_MS } from "../server/lib/time.ts";
import { complete, transferRow } from "../server/modules/transfers/lifecycle.ts";
import { Receivers } from "../server/modules/transfers/receivers.ts";
import { ApiError, Client, member, patchUpload, start, stop, type Instance } from "./support/harness.ts";

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const create = (client: Client, extra: Partial<TransferInput> = {}) =>
  client.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: client.tab,
      name: null,
      folders: [],
      files: [{ path: "folder/data.bin", size: 4, mime: "" }],
      ...extra,
    },
  });
const item = (instance: Instance, id: string) => instance.ctx.db.get<ItemRow>("SELECT * FROM items WHERE id = ?", id)!;
const owner = (instance: Instance, id: string) => item(instance, id).owner;
const save = (client: Client, id: string) =>
  client.call(api.transfers.complete, {
    params: { id },
    body: { destination: { kind: "save" } },
  });
const rejected = (error: unknown) =>
  typeof error === "object" && error !== null && "status" in error && error.status === 410;

test("retention begins at slow first publication, while folder scaffolding and pending bytes have no expiry", async (t) => {
  const instance = await start();
  try {
    const client = await member(instance, "slow-first-save");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    instance.ctx.db.run(
      "UPDATE users SET retention_days = 2, max_retention_days = 5 WHERE username = ?",
      "slow-first-save",
    );
    const transfer = await create(client);
    const admitted = item(instance, transfer.itemId);
    assert.deepEqual(
      [admitted.first_saved_at, admitted.expires, admitted.retention_days, admitted.max_age_days],
      [null, null, 2, 5],
    );
    const entered = gate();
    const release = gate();
    const stage = instance.ctx.blobs.stage.bind(instance.ctx.blobs);
    t.mock.method(instance.ctx.blobs, "stage", async (file: string, hash: string) => {
      await stage(file, hash);
      entered.resolve();
      await release.promise;
    });
    const receiving = patchUpload(client, transfer.uploads[0].id, 0, Buffer.from("data"));
    await entered.promise;
    now += 3 * DAY_MS;
    assert.equal(item(instance, transfer.itemId).first_saved_at, null);
    release.resolve();
    assert.equal((await receiving).statusCode, 204);
    const published = item(instance, transfer.itemId);
    assert.deepEqual([published.first_saved_at, published.expires], [now, now + 2 * DAY_MS]);
    now += DAY_MS;
    await save(client, transfer.id);
    assert.equal(item(instance, transfer.itemId).expires, published.expires, "completion cannot restart the clock");
  } finally {
    await instance.close();
  }
});

test("text, empty files and intentional folder-only content anchor retention, append and cancel preserve that age", async (t) => {
  const instance = await start();
  try {
    const client = await member(instance, "instant-save");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    for (const content of [
      { files: [], text: "note" },
      { files: [{ path: "empty.txt", size: 0, mime: "" }] },
      { files: [], folders: ["empty/nested"] },
    ]) {
      const savedAt = now;
      const first = await create(client, { ...content, retentionDays: 2 });
      assert.deepEqual(
        [item(instance, first.itemId).first_saved_at, item(instance, first.itemId).expires],
        [savedAt, savedAt + 2 * DAY_MS],
      );
      now += 1_000;
      const appended = await create(client, {
        item: first.itemId,
        files: [{ path: "next.txt", size: 0, mime: "" }],
        retentionDays: null,
      });
      await save(client, appended.id);
      assert.equal(item(instance, first.itemId).expires, savedAt + 2 * DAY_MS);
      now += 1_000;
    }
    const folders = await create(client, { files: [], folders: ["saved-empty"] });
    const cancelled = await client.call(api.transfers.cancel, { params: { id: folders.id } });
    assert.equal(cancelled.removed, false, "saved empty folders are meaningful content");
    const scaffolding = await create(client);
    assert.equal((await client.call(api.transfers.cancel, { params: { id: scaffolding.id } })).removed, true);
  } finally {
    await instance.close();
  }
});

test("exact expiry rejects append and PATCH, durably trashes the item and releases only unfinished reservations", async (t) => {
  const instance = await start();
  try {
    const client = await member(instance, "expiry-admission");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const first = await create(client, { text: "saved", retentionDays: 1 });
    const expiry = item(instance, first.itemId).expires!;
    now = expiry;
    await assert.rejects(create(client, { item: first.itemId }), (e) => e instanceof ApiError && e.status === 410);
    assert.equal(item(instance, first.itemId).trashed, expiry);
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", first.id), "cancelled");
    assert.equal(
      instance.ctx.db.value("SELECT count(*) FROM nodes WHERE item = ? AND state = 'pending'", first.itemId),
      0,
    );
    assert.equal(
      instance.ctx.db.value("SELECT text FROM nodes WHERE item = ? AND kind = 'text'", first.itemId),
      "saved",
    );
    assert.equal((await patchUpload(client, first.uploads[0].id, 0, Buffer.from("data"))).statusCode, 410);
    assert.equal(instance.ctx.transfers.outstandingBytes(), 0);
  } finally {
    await instance.close();
  }
});

test("expiry while a body is streaming prevents offset commitment and retains already saved content", async (t) => {
  const instance = await start();
  const receivers = new Receivers(instance.ctx);
  try {
    const client = await member(instance, "expiry-stream");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const transfer = await create(client, { text: "keep me", retentionDays: 1 });
    const entered = gate();
    const release = gate();
    const body = Readable.from(
      (async function* () {
        yield Buffer.from("da");
        entered.resolve();
        await release.promise;
        yield Buffer.from("ta");
      })(),
    );
    const receiving = receivers.receive(transfer.uploads[0].id, 0, body, () => {});
    await entered.promise;
    now = item(instance, transfer.itemId).expires!;
    release.resolve();
    await assert.rejects(receiving, rejected);
    assert.equal(instance.ctx.db.value("SELECT offset FROM uploads WHERE id = ?", transfer.uploads[0].id), 0);
    assert.equal(
      instance.ctx.db.value(
        "SELECT count(*) FROM nodes WHERE item = ? AND state = 'ready' AND kind != 'folder'",
        transfer.itemId,
      ),
      1,
    );
    assert.equal(instance.ctx.transfers.activeUploads(), 0);
    assert.equal(existsSync(receivers.partPath(transfer.uploads[0].id)), false);
  } finally {
    await receivers.close();
    await instance.close();
  }
});

for (const boundary of ["item expiry", "disabled owner"] as const)
  test(`${boundary} during blob staging blocks publication at the transaction boundary`, async (t) => {
    const instance = await start();
    const receivers = new Receivers(instance.ctx);
    try {
      const client = await member(instance, boundary === "item expiry" ? "expiry-stage" : "suspended-stage");
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const transfer = await create(client, { text: "saved", retentionDays: 1 });
      const entered = gate();
      const release = gate();
      const stage = instance.ctx.blobs.stage.bind(instance.ctx.blobs);
      const held = t.mock.method(instance.ctx.blobs, "stage", async (file: string, hash: string) => {
        await stage(file, hash);
        entered.resolve();
        await release.promise;
      });
      const receiving = receivers.receive(transfer.uploads[0].id, 0, Readable.from([Buffer.from("data")]), () => {});
      await entered.promise;
      if (boundary === "item expiry") now = item(instance, transfer.itemId).expires!;
      else instance.ctx.db.run("UPDATE users SET disabled = 1 WHERE id = ?", owner(instance, transfer.itemId));
      release.resolve();
      await assert.rejects(receiving, rejected);
      assert.equal(instance.ctx.db.value("SELECT completed FROM uploads WHERE id = ?", transfer.uploads[0].id), null);
      assert.equal(
        instance.ctx.db.value(
          "SELECT count(*) FROM nodes WHERE item = ? AND kind = 'file' AND state = 'ready'",
          transfer.itemId,
        ),
        0,
      );
      if (boundary === "disabled owner") {
        assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", transfer.id), "open");
        assert.equal(instance.ctx.db.value("SELECT offset FROM uploads WHERE id = ?", transfer.uploads[0].id), 4);
        held.mock.restore();
        instance.ctx.db.run("UPDATE users SET disabled = 0 WHERE id = ?", owner(instance, transfer.itemId));
        await receivers.settle(transfer.uploads[0].id);
        assert.ok(instance.ctx.db.value("SELECT completed FROM uploads WHERE id = ?", transfer.uploads[0].id));
      } else {
        assert.equal(item(instance, transfer.itemId).trashed, now);
        assert.equal(instance.ctx.transfers.activeUploads(), 0);
      }
    } finally {
      await receivers.close();
      await instance.close();
    }
  });

test("completion rechecks owner availability after asynchronous password hashing", async () => {
  const instance = await start();
  const receivers = new Receivers(instance.ctx);
  try {
    const client = await member(instance, "completion-race");
    const transfer = await create(client, { files: [], text: "saved" });
    const principal = memberFromToken(instance.ctx, client.cookies.get("relay"))!;
    const completing = complete(instance.ctx, receivers, transferRow(instance.ctx, transfer.id)!, principal, {
      kind: "link",
      days: 1,
      password: "a secure password",
    });
    instance.ctx.db.run("UPDATE users SET disabled = 1 WHERE id = ?", principal.userId);
    await assert.rejects(completing, rejected);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM links WHERE item = ?", transfer.itemId), 0);
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", transfer.id), "open");
    instance.ctx.db.run("UPDATE users SET disabled = 0 WHERE id = ?", principal.userId);
    await save(client, transfer.id);
  } finally {
    await receivers.close();
    await instance.close();
  }
});

test("accepted storage reservations complete after limits shrink and zero-byte admission remains possible", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "reserved-storage");
    const transfer = await create(client);
    instance.ctx.db.run("UPDATE users SET quota = 0 WHERE id = ?", owner(instance, transfer.itemId));
    instance.ctx.db.setSetting("capacity", "0");
    assert.equal((await patchUpload(client, transfer.uploads[0].id, 0, Buffer.from("data"))).statusCode, 204);
    await save(client, transfer.id);
    const empty = await create(client, { files: [{ path: "zero.txt", size: 0, mime: "" }] });
    await save(client, empty.id);
    await assert.rejects(create(client), (e) => e instanceof ApiError && e.status === 413);
    assert.equal(
      instance.ctx.db.value("SELECT bytes_used FROM users WHERE id = ?", owner(instance, transfer.itemId)),
      4,
    );
  } finally {
    await instance.close();
  }
});

test("restart recovery does not publish a fully received part after the item's deadline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-lifecycle-recovery-"));
  let instance = await start({}, root);
  try {
    const client = await member(instance, "recovery-expiry");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const transfer = await create(client, { text: "saved", retentionDays: 1 });
    const part = join(root, "uploads", `${transfer.uploads[0].id}.part`);
    writeFileSync(part, "data");
    instance.ctx.db.run("UPDATE uploads SET offset = size WHERE id = ?", transfer.uploads[0].id);
    const expiry = item(instance, transfer.itemId).expires!;
    await stop(instance);
    now = expiry;
    instance = await start({}, root);
    assert.equal(item(instance, transfer.itemId).trashed, expiry);
    assert.equal(instance.ctx.transfers.activeUploads(), 0);
    assert.equal(existsSync(part), false);
    assert.equal(
      instance.ctx.db.value("SELECT count(*) FROM nodes WHERE item = ? AND kind = 'file'", transfer.itemId),
      0,
    );
    assert.equal(
      instance.ctx.db.value("SELECT text FROM nodes WHERE item = ? AND kind = 'text'", transfer.itemId),
      "saved",
    );
  } finally {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const boundary of ["request expiry", "grant expiry", "request close"] as const)
  test(`${boundary} while guest bytes are staged releases pending reservations and preserves saved files`, async (t) => {
    const instance = await start();
    const receivers = new Receivers(instance.ctx);
    try {
      const owner = await member(instance, boundary.replaceAll(" ", "-"));
      const request = await owner.call(api.requests.create, {
        body: {
          id: crypto.randomUUID(),
          name: "Guest files",
          description: "",
          days: 5,
          maxBytes: 100,
        },
      });
      const client = new Client(instance);
      await client.call(api.requests.start, { params: { token: request.token } });
      const transfer = await client.call(api.requests.transfer, {
        params: { token: request.token },
        body: {
          id: crypto.randomUUID(),
          tab: client.tab,
          folders: [],
          files: [
            { path: "file.bin", size: 4, mime: "" },
            { path: "saved-empty.txt", size: 0, mime: "" },
          ],
        },
      });
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const entered = gate();
      const release = gate();
      const stage = instance.ctx.blobs.stage.bind(instance.ctx.blobs);
      t.mock.method(instance.ctx.blobs, "stage", async (file: string, hash: string) => {
        await stage(file, hash);
        entered.resolve();
        await release.promise;
      });
      const receiving = receivers.receive(transfer.uploads[0].id, 0, Readable.from([Buffer.from("data")]), () => {});
      await entered.promise;
      if (boundary === "request close")
        instance.ctx.db.run("UPDATE requests SET closed = ? WHERE id = ?", now, request.id);
      else if (boundary === "request expiry") {
        instance.ctx.db.run("UPDATE requests SET expires = ? WHERE id = ?", now + 1, request.id);
        now++;
      } else {
        instance.ctx.db.run("UPDATE guest_grants SET expires = ? WHERE request_id = ?", now + 1, request.id);
        now++;
      }
      release.resolve();
      await assert.rejects(receiving, rejected);
      assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", transfer.id), "cancelled");
      assert.equal(
        instance.ctx.db.value(
          "SELECT name FROM nodes WHERE item = ? AND kind = 'file' AND state = 'ready'",
          transfer.itemId,
        ),
        "saved-empty.txt",
      );
      assert.equal(
        item(instance, transfer.itemId).trashed,
        null,
        "request availability does not delete saved submissions",
      );
      assert.equal(instance.ctx.transfers.activeUploads(), 0);
      assert.equal(instance.ctx.db.value("SELECT count(*) FROM blobs"), 1);
    } finally {
      await receivers.close();
      await instance.close();
    }
  });

test("HEAD with an expired grant settles cancellation even when cached authentication can no longer authorize it", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "expired-guest-head");
    const request = await owner.call(api.requests.create, {
      body: {
        id: crypto.randomUUID(),
        name: "Guest files",
        description: "",
        days: 5,
        maxBytes: 100,
      },
    });
    const client = new Client(instance);
    await client.call(api.requests.start, { params: { token: request.token } });
    const transfer = await client.call(api.requests.transfer, {
      params: { token: request.token },
      body: {
        id: crypto.randomUUID(),
        tab: client.tab,
        folders: [],
        files: [{ path: "file.bin", size: 4, mime: "" }],
      },
    });
    const part = join(instance.root, "uploads", `${transfer.uploads[0].id}.part`);
    writeFileSync(part, "data");
    instance.ctx.db.run("UPDATE uploads SET offset = size WHERE id = ?", transfer.uploads[0].id);
    instance.ctx.db.run("UPDATE guest_grants SET expires = ? WHERE request_id = ?", Date.now(), request.id);
    assert.equal((await client.raw({ method: "HEAD", url: `/uploads/${transfer.uploads[0].id}` })).statusCode, 401);
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", transfer.id), "cancelled");
    assert.equal(instance.ctx.transfers.activeUploads(), 0);
    assert.equal(existsSync(part), false);
  } finally {
    await instance.close();
  }
});

test("expiry detected inside the publication transaction rolls back publication but not lazy invalidation", async (t) => {
  const instance = await start();
  const receivers = new Receivers(instance.ctx);
  try {
    const client = await member(instance, "publication-boundary");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const transfer = await create(client, { text: "saved", retentionDays: 1 });
    const expiry = item(instance, transfer.itemId).expires!;
    let staged = false;
    const stage = instance.ctx.blobs.stage.bind(instance.ctx.blobs);
    t.mock.method(instance.ctx.blobs, "stage", async (file: string, hash: string) => {
      await stage(file, hash);
      staged = true;
    });
    const tx = instance.ctx.db.tx.bind(instance.ctx.db);
    t.mock.method(instance.ctx.db, "tx", <T>(operation: () => T) => {
      if (staged) {
        now = expiry;
        staged = false;
      }
      return tx(operation);
    });
    await assert.rejects(
      receivers.receive(transfer.uploads[0].id, 0, Readable.from([Buffer.from("data")]), () => {}),
      rejected,
    );
    assert.equal(item(instance, transfer.itemId).trashed, expiry);
    assert.equal(instance.ctx.db.value("SELECT completed FROM uploads WHERE id = ?", transfer.uploads[0].id), null);
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", transfer.id), "cancelled");
    assert.equal(
      instance.ctx.db.value("SELECT count(*) FROM nodes WHERE item = ? AND kind = 'file'", transfer.itemId),
      0,
    );
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM blobs"), 0);
  } finally {
    await receivers.close();
    await instance.close();
  }
});
