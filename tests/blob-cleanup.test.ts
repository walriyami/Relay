import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { api } from "../shared/api.ts";
import { thumbnailPath } from "../server/storage/blobs.ts";
import { member, send, start, stop, type Instance } from "./support/harness.ts";

const hash = (data: string) => createHash("sha256").update(data).digest("hex");
const storage = (instance: Instance) => instance.ctx.blobs;
const recorded = (instance: Instance, sha256: string) =>
  instance.ctx.db.value<number>("SELECT count(*) FROM blobs WHERE sha256 = ?", sha256);
function seed(instance: Instance, data: string) {
  const sha256 = hash(data);
  const file = join(instance.root, "uploads", crypto.randomUUID());
  writeFileSync(file, data);
  instance.ctx.blobs.adopt(file, sha256, Buffer.byteLength(data), crc32(Buffer.from(data)));
  return { sha256, file, path: instance.ctx.blobs.path(sha256) };
}
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const ioError = () => Object.assign(new Error("injected cleanup I/O error"), { code: "EIO" });

test("cleanup retains failed blobs and continues independently; maintenance retries after item removal", async () => {
  const instance = await start();
  const unlink = fs.unlinkSync;
  try {
    const client = await member(instance, "cleanup-owner");
    const { result } = await send(client, [
      { path: "retry.txt", data: "retry me" },
      { path: "remove.txt", data: "remove me" },
    ]);
    const failed = instance.ctx.blobs.path(hash("retry me"));
    fs.unlinkSync = (file) => {
      if (file === failed) throw ioError();
      return unlink(file);
    };
    syncBuiltinESMExports();
    await client.call(api.items.trash, { params: { id: result.itemId } });
    // The item transaction has committed even when its following physical cleanup fails.
    await client.call(api.items.remove, { params: { id: result.itemId } }).catch(() => {});
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM items WHERE id = ?", result.itemId), 0);
    assert.equal(recorded(instance, hash("retry me")), 1);
    assert.equal(existsSync(failed), true);
    assert.equal(recorded(instance, hash("remove me")), 0);
    assert.equal(existsSync(instance.ctx.blobs.path(hash("remove me"))), false);
    await instance.sweep();
    const failedStage = instance.ctx.operations.snapshot().maintenance.find((stage) => stage.name === "Blob cleanup");
    assert.equal(failedStage?.failed, true);
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.sweep();
    assert.equal(recorded(instance, hash("retry me")), 0);
    assert.equal(existsSync(failed), false);
    assert.equal(
      instance.ctx.operations.snapshot().maintenance.find((stage) => stage.name === "Blob cleanup")?.failed,
      false,
    );
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("thumbnail unlink failure preserves cleanup intent after the payload is gone", async () => {
  const instance = await start({}, undefined, { setup: false });
  const unlink = fs.unlinkSync;
  try {
    const entry = seed(instance, "partial cleanup");
    const thumbnail = thumbnailPath(instance.root, entry.sha256, "s");
    writeFileSync(thumbnail, "rendition");
    fs.unlinkSync = (file) => {
      if (file === thumbnail) throw ioError();
      return unlink(file);
    };
    syncBuiltinESMExports();
    assert.throws(() => instance.ctx.blobs.collect([entry.sha256]), AggregateError);
    assert.equal(existsSync(entry.path), false);
    assert.equal(recorded(instance, entry.sha256), 1);
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    storage(instance).sweep();
    assert.equal(existsSync(thumbnail), false);
    assert.equal(recorded(instance, entry.sha256), 0);
    instance.ctx.blobs.collect([entry.sha256]);
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("directory sync failure retains its blob row and retries the sync after ENOENT", async () => {
  const instance = await start({}, undefined, { setup: false });
  const sync = fs.fsyncSync;
  try {
    const entry = seed(instance, "sync retry");
    const directory = statSync(dirname(entry.path));
    let attempts = 0;
    fs.fsyncSync = (fd) => {
      const info = fs.fstatSync(fd);
      if (info.dev === directory.dev && info.ino === directory.ino && ++attempts === 1) throw ioError();
      return sync(fd);
    };
    syncBuiltinESMExports();
    assert.throws(() => instance.ctx.blobs.collect([entry.sha256]), AggregateError);
    assert.equal(existsSync(entry.path), false);
    assert.equal(recorded(instance, entry.sha256), 1);
    instance.ctx.blobs.collect([entry.sha256]);
    assert.equal(attempts, 2);
    assert.equal(recorded(instance, entry.sha256), 0);
  } finally {
    fs.fsyncSync = sync;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("startup recovers a stop after item deletion while preserving surviving deduplicated references", async () => {
  const instance = await start();
  let restarted: Instance | undefined;
  try {
    const client = await member(instance, "restart-owner");
    const removed = await send(client, [
      { path: "orphan.txt", data: "unreferenced on restart" },
      { path: "shared.txt", data: "surviving reference" },
    ]);
    await send(client, [{ path: "also-shared.txt", data: "surviving reference" }]);
    instance.ctx.db.run("DELETE FROM items WHERE id = ?", removed.result.itemId);
    const orphan = hash("unreferenced on restart");
    const shared = hash("surviving reference");
    assert.equal(recorded(instance, orphan), 1);
    await stop(instance);
    restarted = await start({}, instance.root);
    assert.equal(recorded(restarted, orphan), 0);
    assert.equal(existsSync(restarted.ctx.blobs.path(orphan)), false);
    assert.equal(recorded(restarted, shared), 1);
    assert.equal(readFileSync(restarted.ctx.blobs.path(shared), "utf8"), "surviving reference");
  } finally {
    await restarted?.close();
    await instance.close();
  }
});

test("periodic cleanup is bounded and failed early candidates do not starve later rows", async () => {
  const instance = await start({}, undefined, { setup: false });
  const unlink = fs.unlinkSync;
  try {
    const hashes = Array.from({ length: 101 }, (_, i) => (i + 1).toString(16).padStart(64, "0"));
    for (const sha256 of hashes)
      instance.ctx.db.run("INSERT INTO blobs(sha256, size, crc32, created) VALUES(?, 0, 0, ?)", sha256, Date.now());
    const failed = instance.ctx.blobs.path(hashes[0]);
    fs.unlinkSync = (file) => {
      if (file === failed) throw ioError();
      return unlink(file);
    };
    syncBuiltinESMExports();
    assert.throws(() => storage(instance).sweep(), AggregateError);
    assert.deepEqual(
      instance.ctx.db.all<{ sha256: string }>("SELECT sha256 FROM blobs ORDER BY sha256").map((row) => row.sha256),
      [hashes[0], hashes[100]],
    );
    storage(instance).sweep();
    assert.equal(recorded(instance, hashes[100]), 0);
    assert.equal(recorded(instance, hashes[0]), 1);
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    storage(instance).sweep();
    assert.equal(recorded(instance, hashes[0]), 0);
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("collection and reconciliation preserve in-flight and completed upload stages", async () => {
  const instance = await start({}, undefined, { setup: false });
  const rename = fsPromises.rename;
  const entered = gate();
  const release = gate();
  let staging: Promise<void> | undefined;
  try {
    const entry = seed(instance, "staged same bytes");
    let temporary = "";
    fsPromises.rename = async (source, target) => {
      if (target === entry.path) {
        temporary = String(source);
        entered.resolve();
        await release.promise;
      }
      return rename(source, target);
    };
    syncBuiltinESMExports();
    staging = instance.ctx.blobs.stage(entry.file, entry.sha256);
    await entered.promise;
    instance.ctx.blobs.collect([entry.sha256]);
    storage(instance).sweep();
    await instance.ctx.blobs.reconcile();
    assert.equal(existsSync(temporary), true);
    assert.equal(recorded(instance, entry.sha256), 1);
    assert.equal(existsSync(entry.path), true);
    release.resolve();
    await staging;
    instance.ctx.blobs.collect([entry.sha256]);
    assert.equal(recorded(instance, entry.sha256), 1);
    storage(instance).unstage(entry.sha256, entry.file);
    storage(instance).sweep();
    assert.equal(recorded(instance, entry.sha256), 0);
  } finally {
    release.resolve();
    await staging;
    fsPromises.rename = rename;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("a rolled-back adoption cannot release another upload's stage of the same bytes", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    const data = "same staged content";
    const sha256 = hash(data);
    const first = join(instance.root, "uploads", "first");
    const second = join(instance.root, "uploads", "second");
    writeFileSync(first, data);
    writeFileSync(second, data);
    await Promise.all([instance.ctx.blobs.stage(first, sha256), instance.ctx.blobs.stage(second, sha256)]);
    assert.throws(
      () =>
        instance.ctx.db.tx(() => {
          instance.ctx.blobs.adopt(first, sha256, data.length, crc32(Buffer.from(data)));
          throw new Error("injected transaction rollback");
        }),
      /transaction rollback/,
    );
    storage(instance).unstage(sha256, first);
    await instance.ctx.blobs.reconcile();
    assert.equal(existsSync(instance.ctx.blobs.path(sha256)), true);
    assert.equal(recorded(instance, sha256), 0);
    storage(instance).unstage(sha256, second);
    assert.equal(existsSync(instance.ctx.blobs.path(sha256)), false);
  } finally {
    await instance.close();
  }
});

test("reconciliation reports orphan unlink failures after cleaning unrelated files and retries", async () => {
  const instance = await start({}, undefined, { setup: false });
  const unlink = fs.unlinkSync;
  try {
    const failed = instance.ctx.blobs.path("a".repeat(64));
    const removed = instance.ctx.blobs.path("b".repeat(64));
    for (const file of [failed, removed]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "orphaned content");
    }
    fs.unlinkSync = (file) => {
      if (file === failed) throw ioError();
      return unlink(file);
    };
    syncBuiltinESMExports();
    await assert.rejects(instance.ctx.blobs.reconcile(), AggregateError);
    assert.equal(existsSync(removed), false);
    assert.equal(existsSync(failed), true);
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    assert.equal((await instance.ctx.blobs.reconcile()).removedFiles, 1);
    assert.equal(existsSync(failed), false);
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("reconciliation does not mark an adoption after its directory snapshot missing", async () => {
  const instance = await start({}, undefined, { setup: false });
  const readdir = fsPromises.readdir;
  const entered = gate();
  const release = gate();
  let reconciliation: ReturnType<typeof instance.ctx.blobs.reconcile> | undefined;
  try {
    fsPromises.readdir = (async (...args: Parameters<typeof readdir>) => {
      const entries = await readdir(...args);
      if (args[0] === join(instance.root, "blobs")) {
        entered.resolve();
        await release.promise;
      }
      return entries;
    }) as typeof readdir;
    syncBuiltinESMExports();
    reconciliation = instance.ctx.blobs.reconcile();
    await entered.promise;
    const entry = seed(instance, "adopted after snapshot");
    release.resolve();
    assert.deepEqual((await reconciliation).missing, []);
    assert.equal(instance.ctx.db.value("SELECT integrity FROM blobs WHERE sha256 = ?", entry.sha256), "ok");
  } finally {
    release.resolve();
    await reconciliation;
    fsPromises.readdir = readdir;
    syncBuiltinESMExports();
    await instance.close();
  }
});
