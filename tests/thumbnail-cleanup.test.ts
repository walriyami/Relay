import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { api, urls } from "../shared/api.ts";
import { thumbnailFailure, thumbnailPath } from "../server/storage/blobs.ts";
import { member, send, start, stop, type Instance } from "./support/harness.ts";

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const ioError = () => Object.assign(new Error("injected thumbnail cleanup I/O error"), { code: "EIO" });
const pending = (instance: Instance, sha: string) =>
  instance.ctx.db.value<number>(
    "SELECT (SELECT count(*) FROM blobs WHERE sha256 = ?) + (SELECT count(*) FROM blob_cleanup WHERE sha256 = ?)",
    sha,
    sha,
  )!;

for (const kind of ["rendition", "decoder marker"] as const) {
  test(`${kind} publication during purge retains failed cleanup and protects its active temporary from reconciliation`, async () => {
    const instance = await start();
    const rename = fsPromises.rename;
    const unlink = fs.unlinkSync;
    const entered = gate();
    const resume = gate();
    let request: Promise<unknown> | undefined;
    try {
      const owner = await member(instance, "thumbnail-purge-owner");
      const data =
        kind === "rendition"
          ? await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } })
              .png()
              .toBuffer()
          : Buffer.from("not a valid image");
      const sha = createHash("sha256").update(data).digest("hex");
      const target =
        kind === "rendition" ? thumbnailPath(instance.root, sha, "s") : thumbnailFailure(instance.root, sha, "image");
      const { result } = await send(owner, [{ path: "sensitive.png", data, mime: "image/png" }]);
      const node = (await owner.call(api.items.get, { params: { id: result.itemId } })).nodes[0];
      let temporary = "";
      fsPromises.rename = async (...args: Parameters<typeof rename>) => {
        if (args[1] === target) {
          temporary = String(args[0]);
          entered.resolve();
          await resume.promise;
        }
        return rename(...args);
      };
      fs.unlinkSync = (file) => {
        if (file === target) throw ioError();
        return unlink(file);
      };
      syncBuiltinESMExports();
      const thumbnail = owner.raw({ method: "GET", url: urls.nodeThumbnail(node.id) });
      request = thumbnail;
      await entered.promise;
      assert.equal(existsSync(temporary), true);
      await owner.call(api.items.trash, { params: { id: result.itemId } });
      await owner.call(api.items.remove, { params: { id: result.itemId } });
      assert.equal(instance.ctx.db.value("SELECT count(*) FROM nodes WHERE blob = ?", sha), 0);
      await instance.ctx.blobs.reconcile();
      assert.equal(existsSync(temporary), true, "reconciliation must preserve an active renderer's temporary");
      assert.ok(pending(instance, sha) > 0);
      resume.resolve();
      const response = await thumbnail;
      assert.ok(response.statusCode >= 400);
      assert.equal(existsSync(target), true);
      assert.ok(pending(instance, sha) > 0, "failed rendition deletion remains durable after render settles");
      fs.unlinkSync = unlink;
      fsPromises.rename = rename;
      syncBuiltinESMExports();
      await instance.sweep();
      assert.equal(existsSync(target), false);
      assert.equal(existsSync(temporary), false);
      assert.equal(existsSync(instance.ctx.blobs.path(sha)), false);
      assert.equal(pending(instance, sha), 0);
    } finally {
      resume.resolve();
      fsPromises.rename = rename;
      fs.unlinkSync = unlink;
      syncBuiltinESMExports();
      await request;
      await instance.close();
    }
  });

  test(`${kind} rename and temporary unlink failures remain retryable without deleting shared source bytes`, async () => {
    const instance = await start();
    const rename = fsPromises.rename;
    const unlink = fs.unlinkSync;
    try {
      const owner = await member(instance, "thumbnail-temporary-owner");
      const data =
        kind === "rendition"
          ? await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } })
              .png()
              .toBuffer()
          : Buffer.from("not a valid image");
      const sha = createHash("sha256").update(data).digest("hex");
      const target =
        kind === "rendition" ? thumbnailPath(instance.root, sha, "s") : thumbnailFailure(instance.root, sha, "image");
      const { result } = await send(owner, [{ path: "photo.png", data, mime: "image/png" }]);
      await send(owner, [{ path: "shared.png", data, mime: "image/png" }]);
      const node = (await owner.call(api.items.get, { params: { id: result.itemId } })).nodes[0];
      let temporary = "";
      fsPromises.rename = async (...args: Parameters<typeof rename>) => {
        if (args[1] === target) {
          temporary = String(args[0]);
          throw ioError();
        }
        return rename(...args);
      };
      fs.unlinkSync = (file) => {
        if (file === temporary) throw ioError();
        return unlink(file);
      };
      syncBuiltinESMExports();
      const response = await owner.raw({ method: "GET", url: urls.nodeThumbnail(node.id) });
      assert.ok(response.statusCode >= 400);
      assert.equal(existsSync(temporary), true);
      assert.equal(instance.ctx.db.value("SELECT count(*) FROM blob_cleanup WHERE sha256 = ?", sha), 1);
      assert.deepEqual(readFileSync(instance.ctx.blobs.path(sha)), data);
      fsPromises.rename = rename;
      fs.unlinkSync = unlink;
      syncBuiltinESMExports();
      await instance.sweep();
      assert.equal(existsSync(temporary), false);
      assert.equal(instance.ctx.db.value("SELECT count(*) FROM blob_cleanup WHERE sha256 = ?", sha), 0);
      assert.equal(instance.ctx.db.value("SELECT count(*) FROM nodes WHERE blob = ?", sha), 2);
      assert.deepEqual(readFileSync(instance.ctx.blobs.path(sha)), data);
    } finally {
      fsPromises.rename = rename;
      fs.unlinkSync = unlink;
      syncBuiltinESMExports();
      await instance.close();
    }
  });
}

test("thumbnail publication and cleanup directory sync failures keep intent until a durable retry", async () => {
  const instance = await start();
  const sync = fs.fsyncSync;
  try {
    const owner = await member(instance, "thumbnail-sync-owner");
    const data = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const sha = createHash("sha256").update(data).digest("hex");
    const { result } = await send(owner, [{ path: "photo.png", data, mime: "image/png" }]);
    const node = (await owner.call(api.items.get, { params: { id: result.itemId } })).nodes[0];
    const directory = statSync(join(instance.root, "thumbnails"));
    let syncs = 0;
    let failing = true;
    fs.fsyncSync = (fd) => {
      const info = fs.fstatSync(fd);
      if (info.dev === directory.dev && info.ino === directory.ino) {
        syncs++;
        if (failing) throw ioError();
      }
      return sync(fd);
    };
    syncBuiltinESMExports();
    const response = await owner.raw({ method: "GET", url: urls.nodeThumbnail(node.id) });
    assert.equal(response.statusCode, 503);
    assert.equal(syncs, 2, "publication and cleanup both attempt the required directory sync");
    assert.equal(existsSync(thumbnailPath(instance.root, sha, "s")), false);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM blob_cleanup WHERE sha256 = ?", sha), 1);
    failing = false;
    await instance.sweep();
    assert.equal(syncs, 3, "retry must sync even when the prior cleanup already removed the rendition");
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM blob_cleanup WHERE sha256 = ?", sha), 0);
    assert.deepEqual(readFileSync(instance.ctx.blobs.path(sha)), data);
  } finally {
    fs.fsyncSync = sync;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("startup reclaims an interrupted thumbnail temporary while preserving its referenced source", async () => {
  const instance = await start();
  let restarted: Instance | undefined;
  try {
    const owner = await member(instance, "thumbnail-restart-owner");
    const data = Buffer.from("saved source");
    const sha = createHash("sha256").update(data).digest("hex");
    await send(owner, [{ path: "saved.png", data, mime: "image/png" }]);
    const publication = instance.ctx.blobs.stageThumbnail(sha);
    writeFileSync(publication.file, "interrupted rendering");
    await stop(instance);
    restarted = await start({}, instance.root);
    assert.equal(existsSync(publication.file), false);
    assert.equal(restarted.ctx.db.value("SELECT count(*) FROM blob_cleanup WHERE sha256 = ?", sha), 0);
    assert.deepEqual(readFileSync(restarted.ctx.blobs.path(sha)), data);
  } finally {
    await restarted?.close();
    await instance.close();
  }
});
