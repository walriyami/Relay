import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { Receivers, uploadRow } from "../server/modules/transfers/receivers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, writeFileSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { api, urls } from "../shared/api.ts";
import { LIMITS } from "../shared/model.ts";
import { Client, member, patchUpload, start, stop, type Instance } from "./support/harness.ts";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function createOne(client: Client, data: Buffer, path = "big.bin") {
  const created = await client.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: client.tab,
      name: null,
      folders: [],
      files: [{ path, size: data.length, mime: "application/octet-stream" }],
    },
  });
  return { created, upload: created.uploads[0].id };
}

const head = (client: Client, upload: string) =>
  client.raw({ method: "HEAD", url: urls.upload(upload), headers: { "tus-resumable": "1.0.0" } });

async function download(client: Client, itemId: string) {
  const detail = await client.call(api.items.get, { params: { id: itemId } });
  const file = detail.nodes.find((n) => n.kind === "file")!;
  const res = await client.raw({ method: "GET", url: urls.nodeContent(file.id) });
  assert.equal(res.statusCode, 200);
  return res.rawPayload;
}

test("tus: OPTIONS, HEAD and PATCH track offsets; mismatches, oversize chunks and bad headers are refused", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const data = randomBytes(300_000);
    const { created, upload } = await createOne(client, data);

    const options = await client.raw({ method: "OPTIONS", url: urls.upload(upload) });
    assert.equal(options.statusCode, 204);
    assert.equal(options.headers["tus-version"], "1.0.0");

    let res = await head(client, upload);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["upload-offset"], "0");
    assert.equal(res.headers["upload-length"], String(data.length));
    assert.equal(res.headers["tus-resumable"], "1.0.0");
    assert.equal(res.headers["cache-control"], "no-store");

    res = await patchUpload(client, upload, 0, data.subarray(0, 100_000));
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["upload-offset"], "100000");
    assert.equal((await head(client, upload)).headers["upload-offset"], "100000");

    res = await patchUpload(client, upload, 50_000, data.subarray(50_000, 60_000));
    assert.equal(res.statusCode, 409);
    assert.equal(res.headers["upload-offset"], "100000");

    res = await patchUpload(client, upload, 100_000, Buffer.alloc(250_000));
    assert.equal(res.statusCode, 413, "bytes past the upload's size");

    res = await client.raw({
      method: "PATCH",
      url: urls.upload(upload),
      headers: {
        "tus-resumable": "0.2.2",
        "upload-offset": "100000",
        "content-type": "application/offset+octet-stream",
      },
      payload: Buffer.alloc(1),
    });
    assert.equal(res.statusCode, 412);
    res = await client.raw({
      method: "PATCH",
      url: urls.upload(upload),
      headers: { "tus-resumable": "1.0.0", "upload-offset": "100000", "content-type": "application/json" },
      payload: "{}",
    });
    assert.equal(res.statusCode, 415);
    res = await client.raw({
      method: "PATCH",
      url: urls.upload(upload),
      headers: {
        "tus-resumable": "1.0.0",
        "upload-offset": "100000",
        "content-type": "application/offset+octet-stream",
        "content-length": String(LIMITS.chunkBytes + 1),
      },
      payload: Buffer.alloc(1),
    });
    assert.equal(res.statusCode, 413, "declared chunk larger than the limit");
    assert.equal((await head(client, upload)).headers["upload-offset"], "100000", "failed PATCHes commit nothing");

    // Another member cannot see the upload at all; neither can a signed-out browser.
    const other = await member(instance, "uma");
    assert.equal((await head(other, upload)).statusCode, 404);
    assert.equal((await patchUpload(other, upload, 100_000, data.subarray(100_000))).statusCode, 404);
    assert.equal((await head(new Client(instance), upload)).statusCode, 401);
    assert.equal((await patchUpload(new Client(instance), upload, 100_000, data.subarray(100_000))).statusCode, 401);

    await assert.rejects(
      client.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } }),
      /409/,
    );

    res = await patchUpload(client, upload, 100_000, data.subarray(100_000));
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["upload-offset"], String(data.length));
    const result = await client.call(api.transfers.complete, {
      params: { id: created.id },
      body: { destination: { kind: "save" } },
    });
    assert.equal(sha(await download(client, result.itemId)), sha(data));
    assert.deepEqual(readdirSync(join(instance.root, "uploads")), [], "part file removed after completion");
  } finally {
    await instance.close();
  }
});

test("a lost response: the bytes arrived, HEAD reports the full offset, a replayed PATCH is told so, and complete works", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const data = randomBytes(10_000);
    const { created, upload } = await createOne(client, data);
    await patchUpload(client, upload, 0, data); // response "lost"
    assert.equal((await head(client, upload)).headers["upload-offset"], String(data.length));
    const replay = await patchUpload(client, upload, 0, data);
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.headers["upload-offset"], String(data.length));
    const result = await client.call(api.transfers.complete, {
      params: { id: created.id },
      body: { destination: { kind: "save" } },
    });
    assert.equal(sha(await download(client, result.itemId)), sha(data));
  } finally {
    await instance.close();
  }
});

test("a new PATCH supersedes a stalled one for the same upload", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const data = randomBytes(200_000);
    const { created, upload } = await createOne(client, data);
    await instance.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = instance.app.server.address() as { port: number };

    // A real connection that sends half the body and then stalls.
    let stalledError = false;
    const stalled = request({
      host: "127.0.0.1",
      port,
      method: "PATCH",
      path: urls.upload(upload),
      headers: {
        host: "relay.test",
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "x-relay-csrf": client.csrf,
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
        "content-length": String(data.length),
      },
    });
    const ended = new Promise<void>((resolve) => {
      stalled.on("error", () => ((stalledError = true), resolve()));
      stalled.on("response", (res) => (res.resume(), res.on("end", resolve)));
    });
    stalled.write(data.subarray(0, 100_000));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const retry = await patchUpload(client, upload, 0, data);
    assert.equal(retry.statusCode, 204);
    assert.equal(retry.headers["upload-offset"], String(data.length));
    await ended;
    assert.equal(stalledError, true, "the stalled request was cut off");

    const result = await client.call(api.transfers.complete, {
      params: { id: created.id },
      body: { destination: { kind: "save" } },
    });
    assert.equal(sha(await download(client, result.itemId)), sha(data));
  } finally {
    await instance.close();
  }
});

async function restart(previous: Instance, root: string, clients: Client[]) {
  await stop(previous);
  const next = await start({}, root);
  return {
    instance: next,
    clients: clients.map((c) => {
      const moved = new Client(next);
      for (const [k, v] of c.cookies) moved.cookies.set(k, v);
      moved.csrf = c.csrf;
      return moved;
    }),
  };
}

test("restart mid-upload: the upload resumes from its committed offset and the file hashes correctly", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-restart-"));
  let instance = await start({}, root);
  try {
    let client = await member(instance, "tia");
    const data = randomBytes(3 * 1024 * 1024 + 17);
    const { created, upload } = await createOne(client, data);
    assert.equal((await patchUpload(client, upload, 0, data.subarray(0, 1024 * 1024))).statusCode, 204);
    writeFileSync(join(root, "uploads", "stray.part"), "left over");

    ({
      instance,
      clients: [client],
    } = await restart(instance, root, [client]));
    assert.equal(existsSync(join(root, "uploads", "stray.part")), false, "part files without an upload are removed");
    assert.equal((await head(client, upload)).headers["upload-offset"], String(1024 * 1024));
    assert.equal(
      (await patchUpload(client, upload, 1024 * 1024, data.subarray(1024 * 1024, 2 * 1024 * 1024))).statusCode,
      204,
    );
    assert.equal((await patchUpload(client, upload, 2 * 1024 * 1024, data.subarray(2 * 1024 * 1024))).statusCode, 204);
    const result = await client.call(api.transfers.complete, {
      params: { id: created.id },
      body: { destination: { kind: "save" } },
    });
    assert.equal(sha(await download(client, result.itemId)), sha(data));
  } finally {
    await stop(instance);
    await rm(root, { recursive: true, force: true });
  }
});

test("restart after every byte arrived but before publishing: recovery finishes the upload", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-recover-"));
  let instance = await start({}, root);
  try {
    let client = await member(instance, "tia");
    const data = randomBytes(500_000);
    const { created, upload } = await createOne(client, data);
    assert.equal((await patchUpload(client, upload, 0, data.subarray(0, 200_000))).statusCode, 204);
    await stop(instance);
    // Simulate a crash after the last bytes were fsynced and committed, before the blob was adopted.
    appendFileSync(join(root, "uploads", `${upload}.part`), data.subarray(200_000));
    const db = new DatabaseSync(join(root, "relay.sqlite"));
    db.prepare("UPDATE uploads SET offset = size WHERE id = ?").run(upload);
    db.close();

    instance = await start({}, root);
    const moved = new Client(instance);
    for (const [k, v] of client.cookies) moved.cookies.set(k, v);
    moved.csrf = client.csrf;
    client = moved;
    const result = await client.call(api.transfers.complete, {
      params: { id: created.id },
      body: { destination: { kind: "save" } },
    });
    assert.equal(sha(await download(client, result.itemId)), sha(data));
    assert.deepEqual(readdirSync(join(root, "uploads")), []);
  } finally {
    await stop(instance);
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery after staging preserves the durable hardlink without copying even when copies would hit ENOSPC", async () => {
  const instance = await start();
  const receivers = new Receivers(instance.ctx);
  const original = fs.copyFileSync;
  const originalOpen = fsPromises.open;
  try {
    const client = await member(instance, "staged-recovery-owner");
    const data = Buffer.from("already fsynced and staged upload bytes");
    const { upload, created } = await createOne(client, data);
    const part = receivers.partPath(upload);
    writeFileSync(part, data);
    const file = await fsPromises.open(part, "r+");
    await file.sync();
    await file.close();
    instance.ctx.db.run("UPDATE uploads SET offset = size WHERE id = ?", upload);
    await instance.ctx.blobs.stage(part, sha(data));
    const staged = fs.statSync(part);
    assert.ok(staged.nlink > 1);
    fs.copyFileSync = (...args) => {
      if (args[0] === part) throw Object.assign(new Error("no space for a redundant copy"), { code: "ENOSPC" });
      return original(...args);
    };
    fsPromises.open = async (...args) => {
      if (String(args[0]).endsWith(".detached"))
        throw Object.assign(new Error("no space for a redundant copy"), { code: "ENOSPC" });
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    await receivers.settle(upload);
    assert.ok(instance.ctx.db.value("SELECT completed FROM uploads WHERE id = ?", upload));
    assert.equal(fs.statSync(instance.ctx.blobs.path(sha(data))).ino, staged.ino);
    assert.equal(existsSync(part), false);
    assert.equal(sha(await download(client, created.itemId)), sha(data));
  } finally {
    fs.copyFileSync = original;
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    await receivers.close();
    await instance.close();
  }
});

test("recovery fsyncs a detached and truncated part before staging while preserving the old linked blob", async (t) => {
  const instance = await start();
  const receivers = new Receivers(instance.ctx);
  const original = fsPromises.open;
  const originalCopy = fs.copyFileSync;
  try {
    const client = await member(instance, "truncated-recovery-owner");
    const data = Buffer.from("committed bytes");
    const trailing = Buffer.concat([data, Buffer.from("uncommitted tail")]);
    const { upload, created } = await createOne(client, data);
    const part = receivers.partPath(upload);
    writeFileSync(part, trailing);
    instance.ctx.db.run("UPDATE uploads SET offset = size WHERE id = ?", upload);
    await instance.ctx.blobs.stage(part, sha(trailing));
    const staged = fs.statSync(part);
    const synced = new Set<number>();
    fsPromises.open = async (...args) => {
      const file = await original(...args);
      if (String(args[0]).startsWith(part)) {
        const sync = file.sync.bind(file);
        file.sync = async () => {
          await sync();
          synced.add((await file.stat()).ino);
        };
      }
      return file;
    };
    fs.copyFileSync = () => {
      throw new Error("upload detachment must not copy synchronously");
    };
    syncBuiltinESMExports();
    const stage = instance.ctx.blobs.stage.bind(instance.ctx.blobs);
    t.mock.method(instance.ctx.blobs, "stage", async (file: string, hash: string) => {
      const info = fs.statSync(file);
      assert.notEqual(info.ino, staged.ino);
      assert.equal(info.size, data.length);
      assert.ok(synced.has(info.ino), "the new inode is fsynced before it can be published");
      await stage(file, hash);
    });
    await receivers.settle(upload);
    assert.deepEqual(readFileSync(instance.ctx.blobs.path(sha(trailing))), trailing);
    assert.equal(sha(await download(client, created.itemId)), sha(data));
    instance.ctx.blobs.unstage(sha(trailing));
  } finally {
    fsPromises.open = original;
    fs.copyFileSync = originalCopy;
    syncBuiltinESMExports();
    await receivers.close();
    await instance.close();
  }
});

for (const cancellation of ["discard", "close", "supersede"] as const) {
  test(`asynchronous detachment yields and ${cancellation} cannot publish stale copied bytes`, async (t) => {
    const instance = await start();
    const receivers = new Receivers(instance.ctx);
    const originalOpen = fsPromises.open;
    const originalCopy = fs.copyFileSync;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let copying!: () => void;
    const copyingStarted = new Promise<void>((resolve) => (copying = resolve));
    try {
      const client = await member(instance, `detach-${cancellation}-owner`);
      const data = randomBytes(768 * 1024);
      const offset = cancellation === "supersede" ? data.length / 2 : data.length;
      const trailing = Buffer.concat([data.subarray(0, offset), Buffer.from("uncommitted tail")]);
      const { upload, created } = await createOne(client, data);
      const part = receivers.partPath(upload);
      writeFileSync(part, trailing);
      instance.ctx.db.run("UPDATE uploads SET offset = ? WHERE id = ?", offset, upload);
      await instance.ctx.blobs.stage(part, sha(trailing));
      const staged = fs.statSync(part);
      let firstRead = true;
      fsPromises.open = async (...args) => {
        const file = await originalOpen(...args);
        // Detachment opens the part writable; recovery hashing opens it read-only.
        if (args[0] === part && args[1] === "r+") {
          const read = file.read.bind(file);
          t.mock.method(file, "read", async (...args: Parameters<typeof read>) => {
            if (firstRead) {
              firstRead = false;
              copying();
              await held;
            }
            return read(...args);
          });
        }
        return file;
      };
      fs.copyFileSync = () => {
        throw new Error("upload detachment must not copy synchronously");
      };
      syncBuiltinESMExports();
      const work =
        cancellation === "supersede"
          ? receivers.receive(upload, offset, Readable.from([data.subarray(offset)]), () => {})
          : receivers.settle(upload);
      const rejected = assert.rejects(work, /aborted/i);
      await copyingStarted;
      let yielded = false;
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          yielded = true;
          resolve();
        }),
      );
      assert.equal(yielded, true, "the event loop remains usable while detachment I/O is pending");
      let completion: Promise<unknown> | undefined;
      if (cancellation === "discard") receivers.discard(upload);
      else if (cancellation === "close") completion = receivers.close();
      else completion = receivers.receive(upload, offset, Readable.from([data.subarray(offset)]), () => {});
      release();
      await rejected;
      await completion;
      assert.deepEqual(readFileSync(instance.ctx.blobs.path(sha(trailing))), trailing);
      assert.equal(
        readdirSync(join(instance.root, "uploads")).some((name) => name.endsWith(".detached")),
        false,
      );
      if (cancellation === "discard") assert.equal(existsSync(part), false, "discarded part never reappears");
      else if (cancellation === "close") {
        assert.equal(fs.statSync(part).ino, staged.ino, "shutdown leaves the original durable inode intact");
        assert.equal(instance.ctx.db.value("SELECT completed FROM uploads WHERE id = ?", upload), null);
      } else assert.equal(sha(await download(client, created.itemId)), sha(data));
      instance.ctx.blobs.unstage(sha(trailing));
    } finally {
      release();
      fsPromises.open = originalOpen;
      fs.copyFileSync = originalCopy;
      syncBuiltinESMExports();
      await receivers.close();
      await instance.close();
    }
  });
}

for (const mutation of ["replacement", "source", "shorter"] as const) {
  for (const retry of ["later", "superseding"] as const) {
    test(`detachment ${mutation} change rebuilds SHA and CRC before a ${retry} retry`, async (t) => {
      const instance = await start();
      const receivers = new Receivers(instance.ctx);
      const originalOpen = fsPromises.open;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let copying!: () => void;
      const copyingStarted = new Promise<void>((resolve) => (copying = resolve));
      let superseded!: () => void;
      const cancelled = new Promise<void>((resolve) => (superseded = resolve));
      try {
        const client = await member(instance, `changed-${mutation}-${retry}`);
        const data = Buffer.from("abcdefgh");
        const prefix = Buffer.from(mutation === "shorter" ? "W" : "WXYZ");
        const expected = mutation === "shorter" ? data : Buffer.concat([prefix, data.subarray(4)]);
        const { upload, created } = await createOne(client, data);
        const part = receivers.partPath(upload);
        const linked = `${part}.kept`;
        writeFileSync(part, data.subarray(0, 4));
        fs.linkSync(part, linked);
        instance.ctx.db.run("UPDATE uploads SET offset = 4 WHERE id = ?", upload);
        let firstRead = true;
        fsPromises.open = async (...args) => {
          const file = await originalOpen(...args);
          if (args[0] === part) {
            const read = file.read.bind(file);
            t.mock.method(file, "read", async (...args: Parameters<typeof read>) => {
              const result = await read(...args);
              if (firstRead) {
                firstRead = false;
                copying();
                await held;
              }
              return result;
            });
          }
          return file;
        };
        syncBuiltinESMExports();
        const first = receivers.receive(upload, 4, Readable.from([data.subarray(4)]), superseded);
        const rejected = assert.rejects(
          first,
          retry === "later" ? { status: 503, message: /storage changed/ } : /aborted/i,
        );
        await copyingStarted;
        if (mutation !== "source") {
          writeFileSync(`${part}.replacement`, prefix);
          fs.renameSync(`${part}.replacement`, part);
        } else {
          writeFileSync(part, prefix);
          const changed = new Date(Date.now() + 1000);
          fs.utimesSync(part, changed, changed);
        }
        let completion: Promise<unknown>;
        if (retry === "superseding") {
          completion = receivers.receive(upload, 4, Readable.from([data.subarray(4)]), () => {});
          await cancelled;
          release();
          await rejected;
        } else {
          release();
          await rejected;
          assert.equal(uploadRow(instance.ctx, upload)?.offset, 4);
          assert.deepEqual(readFileSync(part), prefix);
          completion = receivers.receive(upload, 4, Readable.from([data.subarray(4)]), () => {});
        }
        if (mutation === "shorter") {
          assert.deepEqual(await completion, { conflict: 0 });
          completion = receivers.receive(upload, 0, Readable.from([data]), () => {});
        }
        assert.deepEqual(await completion, { offset: data.length });
        assert.deepEqual(readFileSync(linked), mutation === "source" ? prefix : data.subarray(0, 4));
        assert.deepEqual(await download(client, created.itemId), expected);
        const blob = instance.ctx.db.get<{ sha256: string; crc32: number; integrity: string }>(
          "SELECT sha256, crc32, integrity FROM blobs",
        );
        assert.equal(blob?.sha256, sha(expected));
        assert.equal(blob?.crc32, crc32(expected));
        assert.equal(blob?.integrity, "ok");
        assert.equal(
          readdirSync(join(instance.root, "uploads")).some((name) => name.endsWith(".detached")),
          false,
        );
      } finally {
        release();
        fsPromises.open = originalOpen;
        syncBuiltinESMExports();
        await receivers.close();
        await instance.close();
      }
    });
  }
}

test("a completed part replaced after recovery hashed it is rehashed, never published under the old hash", async () => {
  const instance = await start();
  const receivers = new Receivers(instance.ctx);
  const originalStat = fsPromises.stat;
  try {
    const client = await member(instance, "recovery-replaced-owner");
    const original = Buffer.from("original saved bytes");
    const replacement = Buffer.from("replaced saved bytes");
    const { upload, created } = await createOne(client, original);
    const part = receivers.partPath(upload);
    writeFileSync(part, original);
    instance.ctx.db.run("UPDATE uploads SET offset = size WHERE id = ?", upload);
    let replaced = false;
    let stats = 0;
    fsPromises.stat = (async (...args: Parameters<typeof originalStat>) => {
      // The second stat of the part follows EOF: swap in same-size bytes before recovery returns.
      if (args[0] === part && ++stats === 2) {
        replaced = true;
        writeFileSync(`${part}.replacement`, replacement);
        fs.renameSync(`${part}.replacement`, part);
      }
      return originalStat(...args);
    }) as typeof originalStat;
    syncBuiltinESMExports();
    await assert.rejects(receivers.settle(upload), { status: 503, message: /changed/ });
    assert.equal(replaced, true);
    assert.equal(instance.ctx.db.value("SELECT completed FROM uploads WHERE id = ?", upload), null);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM blobs"), 0);
    await receivers.settle(upload);
    assert.deepEqual(await download(client, created.itemId), replacement);
    const blob = instance.ctx.db.get<{ sha256: string; crc32: number }>("SELECT sha256, crc32 FROM blobs");
    assert.equal(blob?.sha256, sha(replacement));
    assert.equal(blob?.crc32, crc32(replacement));
    assert.equal(existsSync(instance.ctx.blobs.path(sha(original))), false);
  } finally {
    fsPromises.stat = originalStat;
    syncBuiltinESMExports();
    await receivers.close();
    await instance.close();
  }
});

test("a part replaced while it is being staged is not published under the hash of its written bytes", async (t) => {
  const instance = await start();
  try {
    const client = await member(instance, "staging-replaced-owner");
    const original = Buffer.from("original upload bytes");
    const replacement = Buffer.from("replaced upload bytes");
    const { upload, created } = await createOne(client, original);
    const part = join(instance.root, "uploads", `${upload}.part`);
    const stage = instance.ctx.blobs.stage.bind(instance.ctx.blobs);
    let replaced = false;
    t.mock.method(instance.ctx.blobs, "stage", async (...args: Parameters<typeof stage>) => {
      if (!replaced) {
        replaced = true;
        writeFileSync(`${part}.replacement`, replacement);
        fs.renameSync(`${part}.replacement`, part);
      }
      await stage(...args);
    });
    assert.equal((await patchUpload(client, upload, 0, original)).statusCode, 503);
    assert.equal(replaced, true);
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM blobs"), 0);
    assert.equal(existsSync(instance.ctx.blobs.path(sha(original))), false);
    assert.equal((await head(client, upload)).statusCode, 200);
    assert.deepEqual(await download(client, created.itemId), replacement);
    assert.equal(instance.ctx.db.value("SELECT blob FROM nodes WHERE item = ?", created.itemId), sha(replacement));
  } finally {
    await instance.close();
  }
});

test("a part replaced before staging never overwrites a published blob with the same hash", async (t) => {
  const instance = await start();
  try {
    const client = await member(instance, "staging-shared-owner");
    const original = Buffer.from("original upload bytes");
    const replacement = Buffer.from("replaced upload bytes");
    const first = await createOne(client, original, "a.bin");
    assert.equal((await patchUpload(client, first.upload, 0, original)).statusCode, 204);
    const { upload, created } = await createOne(client, original, "b.bin");
    const part = join(instance.root, "uploads", `${upload}.part`);
    const stage = instance.ctx.blobs.stage.bind(instance.ctx.blobs);
    let replaced = false;
    t.mock.method(instance.ctx.blobs, "stage", async (...args: Parameters<typeof stage>) => {
      if (!replaced) {
        replaced = true;
        writeFileSync(`${part}.replacement`, replacement);
        fs.renameSync(`${part}.replacement`, part);
      }
      await stage(...args);
    });
    assert.equal((await patchUpload(client, upload, 0, original)).statusCode, 503);
    assert.deepEqual(readFileSync(instance.ctx.blobs.path(sha(original))), original);
    assert.deepEqual(await download(client, first.created.itemId), original);
    assert.equal((await instance.ctx.blobs.scrub()).corrupt, 0);
    assert.equal((await head(client, upload)).statusCode, 200);
    assert.deepEqual(await download(client, created.itemId), replacement);
    assert.deepEqual(await download(client, first.created.itemId), original);
  } finally {
    await instance.close();
  }
});

test("zero-byte files are complete as soon as the transfer is created", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const created = await client.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: client.tab,
        name: null,
        folders: [],
        files: [
          { path: "empty.txt", size: 0, mime: "text/plain" },
          { path: "also-empty.bin", size: 0, mime: "" },
        ],
      },
    });
    const res = await head(client, created.uploads[0].id);
    assert.equal(res.headers["upload-offset"], "0");
    assert.equal(res.headers["upload-length"], "0");
    const result = await client.call(api.transfers.complete, {
      params: { id: created.id },
      body: { destination: { kind: "save" } },
    });
    const detail = await client.call(api.items.get, { params: { id: result.itemId } });
    assert.equal(detail.files, 2);
    const content = await client.raw({ method: "GET", url: urls.nodeContent(detail.nodes[0].id) });
    assert.equal(content.statusCode, 200);
    assert.equal(content.rawPayload.length, 0);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM blobs"), 1, "one shared empty blob");
    assert.deepEqual(readdirSync(join(instance.root, "uploads")), []);
  } finally {
    await instance.close();
  }
});

for (const failure of ["offset", "stage", "publish"] as const) {
  test(`${failure} failure preserves committed hash state and resumes with the correct SHA`, async () => {
    const instance = await start();
    try {
      const client = await member(instance, "tia");
      const data = randomBytes(1000);
      const { upload, created } = await createOne(client, data);
      assert.equal((await patchUpload(client, upload, 0, data.subarray(0, 400))).statusCode, 204);
      const blocked = join(instance.root, "blobs", sha(data).slice(0, 2));
      if (failure === "stage") writeFileSync(blocked, "blocked");
      else
        instance.ctx.db.sqlite.exec(
          failure === "offset"
            ? "CREATE TRIGGER fail_commit BEFORE UPDATE OF offset ON uploads BEGIN SELECT RAISE(ABORT, 'injected offset failure'); END"
            : "CREATE TRIGGER fail_commit BEFORE UPDATE OF state ON nodes WHEN NEW.state = 'ready' BEGIN SELECT RAISE(ABORT, 'injected publish failure'); END",
        );
      assert.equal((await patchUpload(client, upload, 400, data.subarray(400))).statusCode, 500);
      assert.equal(
        instance.ctx.db.value("SELECT offset FROM uploads WHERE id = ?", upload),
        failure === "offset" ? 400 : 1000,
      );
      if (failure === "stage") await rm(blocked);
      else instance.ctx.db.sqlite.exec("DROP TRIGGER fail_commit");
      if (failure === "offset")
        assert.equal((await patchUpload(client, upload, 400, data.subarray(400))).statusCode, 204);
      else {
        const results = await Promise.all([
          head(client, upload),
          client.call(api.transfers.complete, {
            params: { id: created.id },
            body: { destination: { kind: "save" } },
          }),
        ]);
        assert.equal(results[0].statusCode, 200);
      }
      assert.equal(sha(await download(client, created.itemId)), sha(data));
      assert.equal(instance.ctx.db.value("SELECT blob FROM nodes WHERE item = ?", created.itemId), sha(data));
    } finally {
      await instance.close();
    }
  });
}

test("a linked part is detached before uncommitted bytes are truncated or rewritten", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const data = Buffer.from("correct payload");
    const { upload, created } = await createOne(client, data);
    await patchUpload(client, upload, 0, data.subarray(0, 4));
    const part = join(instance.root, "uploads", `${upload}.part`);
    appendFileSync(part, "old trailing bytes");
    const original = Buffer.from("corr" + "old trailing bytes");
    await instance.ctx.blobs.stage(part, sha(original));
    assert.equal((await patchUpload(client, upload, 4, data.subarray(4))).statusCode, 204);
    assert.deepEqual(readFileSync(instance.ctx.blobs.path(sha(original))), original);
    assert.equal(sha(await download(client, created.itemId)), sha(data));
    instance.ctx.blobs.unstage(sha(original));
  } finally {
    await instance.close();
  }
});

test("hash rebuild read errors drop the receiver so retry rebuilds committed bytes", async () => {
  const instance = await start();
  const receivers = new Receivers(instance.ctx);
  try {
    const client = await member(instance, "tia");
    const data = Buffer.from("rebuild safely");
    const { upload, created } = await createOne(client, data);
    await patchUpload(client, upload, 0, data.subarray(0, 4));
    const part = receivers.partPath(upload);
    await rm(part);
    mkdirSync(part);
    await assert.rejects(receivers.receive(upload, 4, Readable.from([data.subarray(4)]), () => {}));
    await rm(part, { recursive: true });
    writeFileSync(part, data.subarray(0, 4));
    assert.deepEqual(await receivers.receive(upload, 4, Readable.from([data.subarray(4)]), () => {}), {
      offset: data.length,
    });
    assert.equal(sha(await download(client, created.itemId)), sha(data));
  } finally {
    await receivers.close();
    await instance.close();
  }
});

test("restart extends expired open tab leases before the startup sweep", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-downtime-"));
  let instance = await start({}, root);
  try {
    let client = await member(instance, "tia");
    const data = Buffer.from("survives downtime");
    const { upload, created } = await createOne(client, data);
    await patchUpload(client, upload, 0, data.subarray(0, 4));
    instance.ctx.db.run("UPDATE tabs SET lease_expires = ?", Date.now() - 2 * instance.ctx.config.tabLeaseMs);
    ({
      instance,
      clients: [client],
    } = await restart(instance, root, [client]));
    assert.equal((await head(client, upload)).headers["upload-offset"], "4");
    assert.equal((await patchUpload(client, upload, 4, data.subarray(4))).statusCode, 204);
    assert.equal(sha(await download(client, created.itemId)), sha(data));
  } finally {
    await stop(instance);
    await rm(root, { recursive: true, force: true });
  }
});

test("transient recovery EIO preserves committed bytes and offset, then retries with the correct hash", async () => {
  const instance = await start();
  const receivers = new Receivers(instance.ctx);
  const original = fs.createReadStream;
  try {
    const client = await member(instance, "recovery-owner");
    const data = Buffer.from("durable committed payload");
    const { upload, created } = await createOne(client, data);
    await patchUpload(client, upload, 0, data.subarray(0, 4));
    const part = receivers.partPath(upload);
    fs.createReadStream = ((...args: Parameters<typeof original>) => {
      if (args[0] === part)
        return new Readable({
          read() {
            this.destroy(Object.assign(new Error("temporary read fault"), { code: "EIO" }));
          },
        });
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    await assert.rejects(
      receivers.receive(upload, 4, Readable.from([data.subarray(4)]), () => {}),
      { status: 503 },
    );
    assert.deepEqual(readFileSync(part), data.subarray(0, 4));
    assert.equal(instance.ctx.db.value("SELECT offset FROM uploads WHERE id = ?", upload), 4);
    fs.createReadStream = original;
    syncBuiltinESMExports();
    assert.deepEqual(await receivers.receive(upload, 4, Readable.from([data.subarray(4)]), () => {}), {
      offset: data.length,
    });
    assert.equal(sha(await download(client, created.itemId)), sha(data));
  } finally {
    fs.createReadStream = original;
    syncBuiltinESMExports();
    await receivers.close();
    await instance.close();
  }
});

for (const loss of ["missing", "short"] as const) {
  test(`recovery resets only a proven ${loss} part`, async () => {
    const instance = await start();
    const receivers = new Receivers(instance.ctx);
    try {
      const client = await member(instance, "recovery-loss-owner");
      const data = Buffer.from("original payload");
      const { upload, created } = await createOne(client, data);
      await patchUpload(client, upload, 0, data.subarray(0, 4));
      const part = receivers.partPath(upload);
      if (loss === "missing") await rm(part);
      else writeFileSync(part, "x");
      assert.deepEqual(await receivers.receive(upload, 4, Readable.from([data.subarray(4)]), () => {}), {
        conflict: 0,
      });
      assert.equal(instance.ctx.db.value("SELECT offset FROM uploads WHERE id = ?", upload), 0);
      assert.deepEqual(await receivers.receive(upload, 0, Readable.from([data]), () => {}), { offset: data.length });
      assert.equal(sha(await download(client, created.itemId)), sha(data));
    } finally {
      await receivers.close();
      await instance.close();
    }
  });
}

test("startup recovery is lazy for partial uploads and concurrent PATCH rebuilds use at most two streams", async () => {
  const instance = await start();
  const receivers = new Receivers(instance.ctx);
  const original = fs.createReadStream;
  const release: (() => void)[] = [];
  let attempts: Promise<unknown>[] = [];
  try {
    const client = await member(instance, "bounded-recovery-owner");
    const entries: { data: Buffer; upload: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const data = Buffer.from(`data-${i}-payload`);
      const { upload } = await createOne(client, data);
      await patchUpload(client, upload, 0, data.subarray(0, 4));
      entries.push({ data, upload });
    }
    let active = 0;
    let maximum = 0;
    let started = 0;
    let two!: () => void;
    let three!: () => void;
    const startedTwo = new Promise<void>((resolve) => {
      two = resolve;
    });
    const startedThree = new Promise<void>((resolve) => {
      three = resolve;
    });
    fs.createReadStream = ((...args: Parameters<typeof original>) => {
      const entry = entries.find((e) => receivers.partPath(e.upload) === args[0]);
      if (!entry) return original(...args);
      return Readable.from(
        (async function* () {
          active++;
          maximum = Math.max(maximum, active);
          started++;
          const wait = new Promise<void>((resolve) => release.push(resolve));
          if (started === 2) two();
          if (started === 3) three();
          await wait;
          active--;
          yield entry.data.subarray(0, 4);
        })(),
      );
    }) as typeof original;
    syncBuiltinESMExports();
    for (const entry of entries) receivers.restore(uploadRow(instance.ctx, entry.upload)!);
    assert.equal(started, 0);
    attempts = entries.map((entry) =>
      receivers.receive(entry.upload, 4, Readable.from([entry.data.subarray(4)]), () => {}),
    );
    await startedTwo;
    assert.equal(started, 2);
    release[0]();
    await startedThree;
    assert.equal(maximum, 2);
    for (const resume of release) resume();
    await Promise.all(attempts);
  } finally {
    for (const resume of release) resume();
    await Promise.allSettled(attempts);
    fs.createReadStream = original;
    syncBuiltinESMExports();
    await receivers.close();
    await instance.close();
  }
});
