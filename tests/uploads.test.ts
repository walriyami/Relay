import { Readable } from "node:stream";
import { Receivers } from "../server/modules/transfers/receivers.ts";
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
