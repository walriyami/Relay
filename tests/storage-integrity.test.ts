import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { api, urls } from "../shared/api.ts";
import { thumbnailFailure, thumbnailPath } from "../server/storage/blobs.ts";
import { member, send, start, type Instance } from "./support/harness.ts";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
async function seed(instance: Instance, data: string | Buffer) {
  const hash = sha(data);
  const file = join(instance.root, "uploads", crypto.randomUUID());
  const buffer = Buffer.from(data);
  writeFileSync(file, buffer);
  await instance.ctx.blobs.stage(file, hash);
  instance.ctx.blobs.adopt(file, hash, buffer.length, crc32(buffer));
  return { hash, file, path: instance.ctx.blobs.path(hash) };
}

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("integrity scrub detects missing, truncated and same-size corrupt blobs; reupload repairs downloads atomically", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "integrity-owner");
    const files = ["healthy", "missing", "truncate", "corrupt"].map((name) => ({
      path: `${name}.bin`,
      data: `${name} payload`,
    }));
    const { result } = await send(client, files);
    const nodes = (await client.call(api.items.get, { params: { id: result.itemId } })).nodes;
    const blobs = instance.ctx.blobs;
    await fsPromises.unlink(blobs.path(sha(files[1].data)));
    writeFileSync(blobs.path(sha(files[2].data)), "short");
    const corruptPath = blobs.path(sha(files[3].data));
    writeFileSync(corruptPath, "x".repeat(files[3].data.length));
    const oldInode = statSync(corruptPath).ino;
    const report = await blobs.scrub();
    assert.deepEqual(
      [report.checked, report.missing, report.corrupt, report.errors, report.complete],
      [4, 1, 2, 0, true],
    );
    const status = blobs.status();
    assert.deepEqual([status.total, status.healthy, status.missing, status.corrupt, status.errors], [4, 1, 1, 2, 0]);
    assert.ok(status.lastFullCheck);
    assert.equal(blobs.degraded(), true);
    for (const name of ["missing", "truncate", "corrupt"])
      assert.equal(
        (await client.raw({ method: "GET", url: urls.nodeContent(nodes.find((n) => n.name === `${name}.bin`)!.id) }))
          .statusCode,
        503,
      );
    assert.equal((await client.raw({ method: "GET", url: urls.itemZip(result.itemId) })).statusCode, 503);
    assert.equal(
      (await client.raw({ method: "GET", url: urls.nodeContent(nodes.find((n) => n.name === "healthy.bin")!.id) }))
        .statusCode,
      200,
    );
    const hash = sha(files[3].data);
    writeFileSync(thumbnailFailure(instance.root, hash, "image"), "invalid");
    writeFileSync(thumbnailFailure(instance.root, hash, "heif"), "invalid");
    writeFileSync(thumbnailPath(instance.root, hash, "s"), "stale");
    await send(client, [files[3]]);
    assert.notEqual(statSync(corruptPath).ino, oldInode);
    assert.equal(readFileSync(corruptPath, "utf8"), files[3].data);
    assert.equal(existsSync(thumbnailFailure(instance.root, hash, "image")), false);
    assert.equal(existsSync(thumbnailFailure(instance.root, hash, "heif")), false);
    assert.equal(existsSync(thumbnailPath(instance.root, hash, "s")), false);
    assert.equal(blobs.status().corrupt, 1, "repair clears only that proven hash");
    await send(client, [files[1], files[2]]);
    assert.equal(blobs.degraded(), false);
    assert.equal((await client.raw({ method: "GET", url: urls.itemZip(result.itemId) })).statusCode, 200);
  } finally {
    await instance.close();
  }
});

for (const damage of ["missing", "corrupt"] as const) {
  test(`zero-byte reupload repairs a ${damage} empty blob for existing and new files`, async () => {
    const instance = await start();
    try {
      const client = await member(instance, `empty-${damage}-owner`);
      const original = await send(client, [{ path: "original.txt", data: "" }]);
      const blobs = instance.ctx.blobs;
      const path = blobs.path(sha(""));
      if (damage === "missing") await fsPromises.unlink(path);
      else writeFileSync(path, "damaged");
      const report = await blobs.scrub();
      assert.equal(report[damage], 1);
      assert.equal(blobs.degraded(), true);

      const replacement = await send(client, [{ path: "replacement.txt", data: "" }]);
      assert.equal(existsSync(path), true);
      assert.equal(statSync(path).size, 0);
      assert.equal(blobs.degraded(), false);
      assert.equal(blobs.status().healthy, 1);
      for (const itemId of [original.result.itemId, replacement.result.itemId]) {
        const item = await client.call(api.items.get, { params: { id: itemId } });
        const response = await client.raw({ method: "GET", url: urls.nodeContent(item.nodes[0].id) });
        assert.equal(response.statusCode, 200);
        assert.equal(response.rawPayload.length, 0);
        assert.equal((await client.raw({ method: "GET", url: urls.itemZip(itemId) })).statusCode, 200);
      }
    } finally {
      await instance.close();
    }
  });
}

test("scrub cursors and cancellation never certify a skipped prefix; validated chunks can complete a full scan", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    const entries = await Promise.all([seed(instance, "one"), seed(instance, "two"), seed(instance, "three")]);
    const blobs = instance.ctx.blobs;
    const first = await blobs.scrub({ limit: 1 });
    assert.equal(first.checked, 1);
    assert.equal(first.complete, false);
    assert.ok(first.nextAfter);
    assert.equal(blobs.status().lastFullCheck, null);
    const second = await blobs.scrub({ after: first.nextAfter, maxBytes: 1 });
    assert.equal(second.checked, 1, "one whole object makes progress through a byte budget");
    const last = await blobs.scrub({ after: second.nextAfter! });
    assert.equal(last.complete, true);
    assert.ok(blobs.status().lastFullCheck);
    instance.ctx.db.run("DELETE FROM settings WHERE key LIKE 'blob_scrub_%'");
    const after = entries.map((e) => e.hash).sort()[0];
    assert.equal((await blobs.scrub({ after })).complete, true);
    assert.equal(blobs.status().lastFullCheck, null, "arbitrary cursor cannot certify prefix");
    const partial = await blobs.scrub({ limit: 1 });
    const abort = new AbortController();
    abort.abort();
    const cancelled = await blobs.scrub({ after: partial.nextAfter!, signal: abort.signal });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.complete, false);
    await blobs.scrub({ after: partial.nextAfter! });
    assert.equal(blobs.status().lastFullCheck, null, "cancelled chain cannot certify prefix");
  } finally {
    await instance.close();
  }
});

test("scrub persists transient read errors until a successful retry and does not certify failed scans", async () => {
  const instance = await start({}, undefined, { setup: false });
  const original = fsPromises.open;
  try {
    const entry = await seed(instance, "stored payload");
    fsPromises.open = async (...args: Parameters<typeof original>) => {
      if (args[0] === entry.path) throw Object.assign(new Error("injected I/O error"), { code: "EIO" });
      return original(...args);
    };
    syncBuiltinESMExports();
    const result = await instance.ctx.blobs.scrub();
    assert.equal(result.errors, 1);
    assert.equal(instance.ctx.blobs.status().errors, 1);
    assert.equal(instance.ctx.blobs.status().lastFullCheck, null);
    // A transient read error remains visible, but a later successful cheap stat can retry serving.
    await instance.ctx.blobs.verify(entry.hash);
    assert.equal(instance.ctx.blobs.status().errors, 1);
    fsPromises.open = original;
    syncBuiltinESMExports();
    assert.equal((await instance.ctx.blobs.scrub()).errors, 0);
    await instance.ctx.blobs.verify(entry.hash);
    assert.equal(instance.ctx.blobs.degraded(), false);
  } finally {
    fsPromises.open = original;
    syncBuiltinESMExports();
    await instance.close();
  }
});

for (const change of ["repair", "delete", "shutdown"] as const) {
  test(`scrub is single-flight and ${change} during a read cannot persist a stale integrity result`, async () => {
    const instance = await start({}, undefined, { setup: false });
    const original = fsPromises.open;
    const opened = gate();
    const release = gate();
    let scan: ReturnType<typeof instance.ctx.blobs.scrub> | undefined;
    try {
      const entry = await seed(instance, "correct payload");
      writeFileSync(entry.path, "incorrect bytes");
      let held = false;
      fsPromises.open = async (...args: Parameters<typeof original>) => {
        const file = await original(...args);
        if (args[0] === entry.path && !held) {
          held = true;
          opened.resolve();
          await release.promise;
        }
        return file;
      };
      syncBuiltinESMExports();
      scan = instance.ctx.blobs.scrub();
      await opened.promise;
      assert.equal(instance.ctx.blobs.status().running, true);
      assert.throws(() => instance.ctx.blobs.scrub(), { status: 409 });
      if (change === "repair") await seed(instance, "correct payload");
      else if (change === "delete") instance.ctx.blobs.collect([entry.hash]);
      let closed: Promise<void> | undefined;
      if (change === "shutdown") closed = instance.ctx.blobs.close();
      release.resolve();
      const result = await scan;
      await closed;
      assert.equal(instance.ctx.blobs.status().running, false);
      if (change === "repair") {
        await instance.ctx.blobs.verify(entry.hash);
        assert.equal(instance.ctx.blobs.status().corrupt, 0);
      } else if (change === "delete") assert.equal(instance.ctx.blobs.status().total, 0);
      else {
        assert.equal(result.cancelled, true);
        assert.equal(result.complete, false);
        assert.equal(instance.ctx.blobs.status().lastFullCheck, null);
      }
    } finally {
      release.resolve();
      await scan;
      fsPromises.open = original;
      syncBuiltinESMExports();
      await instance.close();
    }
  });
}

test("scrub exposes settled results and rejected runs without leaving running stuck", async (t) => {
  const instance = await start({}, undefined, { setup: false });
  try {
    await seed(instance, "healthy bytes");
    const db = instance.ctx.db;
    const original = db.get.bind(db);
    const fault = t.mock.method(db, "get", (sql: string, ...args: Parameters<typeof db.get>[1][]) => {
      if (sql.startsWith("SELECT * FROM blobs WHERE sha256 >")) throw new Error("injected database fault");
      return original(sql, ...args);
    });
    const failed = instance.ctx.blobs.scrub();
    assert.equal(instance.ctx.blobs.status().running, true);
    await assert.rejects(failed, /injected database fault/);
    assert.equal(instance.ctx.blobs.status().running, false);
    assert.equal(instance.ctx.blobs.status().lastError, true);
    assert.equal(instance.ctx.blobs.degraded(), true);
    fault.mock.restore();
    const healthy = instance.ctx.blobs.scrub();
    assert.equal(instance.ctx.blobs.status().lastError, false);
    const result = await healthy;
    assert.deepEqual(instance.ctx.blobs.status().lastResult, result);
    assert.equal(instance.ctx.blobs.degraded(), false);
  } finally {
    await instance.close();
  }
});

test("cancelling a scrub during an active hash stream closes it without marking a partial read corrupt", async () => {
  const instance = await start({}, undefined, { setup: false });
  const original = fsPromises.open;
  const abort = new AbortController();
  try {
    const entry = await seed(instance, Buffer.alloc(1024 * 1024, 7));
    fsPromises.open = async (...args: Parameters<typeof original>) => {
      const file = await original(...args);
      if (args[0] === entry.path) {
        const read = file.createReadStream.bind(file);
        file.createReadStream = (...options: Parameters<typeof read>) => {
          const stream = read(...options);
          stream.once("data", () => abort.abort());
          return stream;
        };
      }
      return file;
    };
    syncBuiltinESMExports();
    const result = await instance.ctx.blobs.scrub({ signal: abort.signal });
    assert.equal(result.cancelled, true);
    assert.equal(result.checked, 0);
    assert.equal(instance.ctx.blobs.status().corrupt, 0);
    assert.equal(instance.ctx.blobs.status().lastFullCheck, null);
  } finally {
    fsPromises.open = original;
    syncBuiltinESMExports();
    await instance.close();
  }
});
