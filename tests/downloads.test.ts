import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type AvifOptions } from "sharp";
import { api, urls } from "../shared/api.ts";
import { MAX_QUEUED_PER_PERSON, RENDITION_RETRY_MS } from "../server/modules/downloads/thumbnails.ts";
import { imageSignature } from "../server/modules/downloads/image-signature.ts";
import { heifLayout } from "../server/modules/downloads/heif-layout.ts";
import { decodeRefusal, heicRefusal, jpegLayout } from "../server/modules/downloads/image-limits.ts";
import { Client, member, send, start } from "./support/harness.ts";
import { heic, hevcSps } from "./support/heif.ts";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const get = (client: Client, url: string, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET") =>
  client.raw({ method, url, headers });

test("content: whole file, ranges, suffix ranges, 416, If-Range and HEAD", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const data = randomBytes(1000);
    const { result } = await send(client, [{ path: "data.bin", data }]);
    const node = (await client.call(api.items.get, { params: { id: result.itemId } })).nodes[0];
    const url = urls.nodeContent(node.id);

    let res = await get(client, url);
    assert.equal(res.statusCode, 200);
    assert.equal(sha(res.rawPayload), sha(data));
    assert.equal(res.headers.etag, `"${sha(data)}"`);
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(res.headers["content-type"], "application/octet-stream");
    assert.equal(res.headers["content-disposition"], "attachment; filename*=UTF-8''data.bin");
    const etag = res.headers.etag;

    res = await get(client, url, { range: "bytes=100-199" });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers["content-range"], "bytes 100-199/1000");
    assert.equal(res.headers["content-length"], "100");
    assert.deepEqual(res.rawPayload, data.subarray(100, 200));
    res = await get(client, url, { range: "bytes=-10" });
    assert.deepEqual(res.rawPayload, data.subarray(990));
    res = await get(client, url, { range: "bytes=995-" });
    assert.deepEqual(res.rawPayload, data.subarray(995));
    res = await get(client, url, { range: "bytes=900-5000" });
    assert.equal(res.headers["content-range"], "bytes 900-999/1000");
    for (const range of ["bytes=1000-", "bytes=5-2", "bytes=abc", "bytes=-"]) {
      res = await get(client, url, { range });
      assert.equal(res.statusCode, 416, range);
      assert.equal(res.headers["content-range"], "bytes */1000");
    }
    res = await get(client, url, { range: "bytes=0-9", "if-range": etag });
    assert.equal(res.statusCode, 206);
    res = await get(client, url, { range: "bytes=0-9", "if-range": '"stale"' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.rawPayload.length, 1000);

    res = await get(client, url, {}, "HEAD");
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-length"], "1000");
    assert.equal(res.rawPayload.length, 0);
  } finally {
    await instance.close();
  }
});

test("content: inline only for passive types, with a sandbox or PDF policy; text nodes and folders", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const { result } = await send(
      client,
      [
        { path: "p.png", data: "png", mime: "image/png" },
        { path: "doc.pdf", data: "pdf", mime: "" },
        { path: "page.html", data: "<script>alert(1)</script>", mime: "text/html" },
        { path: "tool.exe", data: "MZ", mime: "application/x-msdownload" },
        { path: "Dir/résumé (1).txt", data: "cv", mime: "text/plain" },
      ],
      { text: "héllo" },
    );
    const nodes = new Map(
      (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.map((n) => [n.path, n]),
    );
    const inline = (path: string) => get(client, urls.nodeContent(nodes.get(path)!.id, { inline: true }));

    let res = await inline("p.png");
    assert.equal(res.headers["content-type"], "image/png");
    assert.match(res.headers["content-disposition"] as string, /^inline;/);
    assert.equal(res.headers["content-security-policy"], "sandbox; default-src 'none'; frame-ancestors 'self'");
    assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
    res = await inline("doc.pdf");
    assert.equal(res.headers["content-type"], "application/pdf");
    assert.match(res.headers["content-security-policy"] as string, /^default-src 'none'; frame-ancestors 'self'/);
    res = await inline("page.html");
    assert.match(res.headers["content-type"] as string, /^text\/plain/);
    assert.match(res.headers["content-security-policy"] as string, /^sandbox/);
    res = await inline("tool.exe");
    assert.equal(res.headers["content-type"], "application/octet-stream");
    assert.match(res.headers["content-disposition"] as string, /^attachment;/);
    assert.equal(res.headers["x-frame-options"], "DENY");
    res = await get(client, urls.nodeContent(nodes.get("Dir/résumé (1).txt")!.id));
    assert.equal(res.headers["content-disposition"], "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.txt");

    res = await inline("Text.txt");
    assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(res.body, "héllo");
    assert.equal(res.headers.etag, `"${sha("héllo")}"`);
    res = await get(client, urls.nodeContent(nodes.get("Dir")!.id));
    assert.equal(res.statusCode, 400);
  } finally {
    await instance.close();
  }
});

test("content authorization: other members, signed-out browsers and pending nodes get nothing", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const { result } = await send(client, [{ path: "secret.txt", data: "secret" }]);
    const node = (await client.call(api.items.get, { params: { id: result.itemId } })).nodes[0];
    const other = await member(instance, "uma");
    for (const url of [urls.nodeContent(node.id), urls.nodeThumbnail(node.id), urls.itemZip(result.itemId)])
      assert.equal((await get(other, url)).statusCode, 404, url);
    assert.equal((await get(new Client(instance), urls.nodeContent(node.id))).statusCode, 401);

    const pending = await client.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: client.tab,
        name: null,
        folders: [],
        files: [{ path: "p.bin", size: 5, mime: "" }],
      },
    });
    const pendingNode = instance.ctx.db.value<string>("SELECT node FROM uploads WHERE id = ?", pending.uploads[0].id)!;
    assert.equal((await get(client, urls.nodeContent(pendingNode))).statusCode, 404);
    assert.equal((await get(client, urls.itemZip(pending.itemId))).statusCode, 404, "nothing ready to zip");

    // A blob whose file went missing is refused rather than streamed short.
    instance.ctx.db.run("UPDATE nodes SET size = size + 1 WHERE id = ?", node.id);
    assert.equal((await get(client, urls.nodeContent(node.id))).statusCode, 503);
  } finally {
    await instance.close();
  }
});

test("share routes serve only the link's item, and stop when the link is revoked", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const shared = await send(client, [{ path: "Folder/a.txt", data: "shared" }], {
      destination: { kind: "link", days: 7 },
    });
    const privateItem = await send(client, [{ path: "b.txt", data: "private" }]);
    const token = shared.result.link!.token;
    const nodes = new Map(
      (await client.call(api.items.get, { params: { id: shared.result.itemId } })).nodes.map((n) => [n.path, n]),
    );
    const privateNode = (await client.call(api.items.get, { params: { id: privateItem.result.itemId } })).nodes[0];
    const guest = new Client(instance);

    let res = await get(guest, urls.shareContent(token, nodes.get("Folder/a.txt")!.id));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "shared");
    res = await get(guest, urls.shareContent(token, privateNode.id));
    assert.equal(res.statusCode, 404);
    res = await get(guest, urls.shareZip(token, nodes.get("Folder")!.id));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/zip");
    assert.equal(res.headers["content-disposition"], "attachment; filename*=UTF-8''Folder.zip");
    const twice = `${urls.shareZip(token, nodes.get("Folder")!.id)}&folder=${privateNode.id}`;
    assert.equal((await get(guest, twice)).statusCode, 404, "a repeated folder is no folder, not an error");
    res = await get(guest, urls.shareZip(token, privateNode.id));
    assert.equal(res.statusCode, 404);
    assert.equal((await get(guest, urls.shareContent("not-a-token", privateNode.id))).statusCode, 404);

    await client.call(api.links.revoke, { params: { id: shared.result.link!.id } });
    assert.equal((await get(guest, urls.shareContent(token, nodes.get("Folder/a.txt")!.id))).statusCode, 404);
    assert.equal((await get(guest, urls.shareZip(token))).statusCode, 404);
  } finally {
    await instance.close();
  }
});

test("thumbnails: a webp rendition keyed by blob hash, cached with ETag, removed with its blob", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 240, g: 107, b: 71 } },
    })
      .png()
      .toBuffer();
    const { result } = await send(
      client,
      [
        { path: "photo.png", data: png, mime: "image/png" },
        { path: "notes.txt", data: "not an image", mime: "text/plain" },
      ],
      { destination: { kind: "link", days: 7 } },
    );
    const nodes = new Map(
      (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.map((n) => [n.name, n]),
    );
    const photo = nodes.get("photo.png")!;

    let res = await get(client, urls.nodeThumbnail(photo.id));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/webp");
    assert.equal(res.headers["cache-control"], "private, max-age=86400");
    const meta = await sharp(res.rawPayload).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 640, 427]);
    const file = join(instance.root, "thumbnails", `${sha(png)}-s.webp`);
    assert.equal(existsSync(file), true);
    const etag = res.headers.etag as string;
    assert.equal(etag, `"${sha(png)}-s"`);
    assert.equal((await get(client, urls.nodeThumbnail(photo.id), { "if-none-match": etag })).statusCode, 304);

    res = await get(client, urls.nodeThumbnail(photo.id, "l"));
    assert.equal((await sharp(res.rawPayload).metadata()).width, 1200, "never enlarged");
    assert.equal((await get(client, urls.nodeThumbnail(nodes.get("notes.txt")!.id))).statusCode, 415);
    assert.equal((await get(new Client(instance), urls.shareThumbnail(result.link!.token, photo.id))).statusCode, 200);

    await client.call(api.items.trash, { params: { id: result.itemId } });
    await client.call(api.items.remove, { params: { id: result.itemId } });
    assert.equal(existsSync(file), false);
  } finally {
    await instance.close();
  }
});

/** Distinct small photos, so each needs its own rendition. */
const photos = (count: number, offset = 0) =>
  Promise.all(
    Array.from({ length: count }, async (_, i) => ({
      path: `images/${offset + i}.png`,
      mime: "image/png",
      data: await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 3,
          background: { r: (offset + i) % 256, g: (offset + i) >> 8, b: 9 },
        },
      })
        .png()
        .toBuffer(),
    })),
  );

async function sentPhotos(client: Client, count: number, offset = 0) {
  const files = await photos(count, offset);
  const { result } = await send(client, files);
  const nodes = (await client.call(api.items.get, { params: { id: result.itemId } })).nodes;
  return nodes
    .filter((n) => n.kind === "file")
    .map((n) => ({ ...n, blob: sha(files.find((f) => f.path.endsWith(`/${n.name}`))!.data) }));
}

/**
 * Stands in for the render worker: holds each job until the test releases it, then renders it in
 * this thread, so a test can fill the queue and watch the order jobs start in.
 */
function heldWorkers() {
  const started: { job: { id: number; source: string; target: string; width: number }; worker: EventEmitter }[] = [];
  const pending: typeof started = [];
  class HeldWorker extends EventEmitter {
    postMessage(job: (typeof started)[number]["job"]) {
      started.push({ job, worker: this });
      pending.push({ job, worker: this });
    }
    unref() {}
    terminate() {
      return Promise.resolve(0);
    }
  }
  let rendition: Buffer | undefined;
  const release = async () => {
    const next = pending.shift();
    if (!next) return false;
    // Any small picture will do: what's tested is the order jobs start in, not the rendering.
    rendition ??= await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } })
      .webp()
      .toBuffer();
    writeFileSync(next.job.target, rendition);
    next.worker.emit("message", { id: next.job.id, ok: true });
    return true;
  };
  return { HeldWorker, started, release };
}

test("thumbnails: a photo album opened all at once fills in completely", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "album-owner");
    const nodes = await sentPhotos(client, 60);
    // A phone asks for every visible photo at once.
    const responses = await Promise.all(nodes.map((node) => get(client, urls.nodeThumbnail(node.id))));
    assert.deepEqual(
      responses.map((response) => response.statusCode),
      nodes.map(() => 200),
    );
  } finally {
    await instance.close();
  }
});

test("thumbnails: one person's backlog is bounded with a retry hint, and others still get their turn", async () => {
  const instance = await start();
  const original = workerThreads.Worker;
  const held = heldWorkers();
  try {
    const flood = await member(instance, "thumbnail-flood");
    const other = await member(instance, "thumbnail-other");
    const many = await sentPhotos(flood, MAX_QUEUED_PER_PERSON + 4);
    const [mine] = await sentPhotos(other, 1, 5000);
    workerThreads.Worker = held.HeldWorker as unknown as typeof original;
    syncBuiltinESMExports();

    const flooding = many.map((node) => get(flood, urls.nodeThumbnail(node.id)));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const asking = get(other, urls.nodeThumbnail(mine.id));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The other person's photo is next in turn, not behind the whole backlog.
    // Release jobs until every request is answered; the next job may start a moment after one ends.
    let answered = false;
    const all = Promise.all([...flooding, asking]).finally(() => (answered = true));
    while (!answered) if (!(await held.release())) await new Promise((resolve) => setTimeout(resolve, 5));
    const responses = (await all).slice(0, -1);
    assert.equal((await asking).statusCode, 200);
    const order = held.started.map((s) => s.job.source);
    const theirs = order.findIndex((source) => source.endsWith(mine.blob));
    assert.ok(theirs !== -1 && theirs <= 3, `the other person's photo started at position ${theirs}`);

    const overloaded = responses.filter((response) => response.statusCode === 503);
    assert.ok(overloaded.length >= 2, "a backlog past the limit is turned away rather than kept without bound");
    assert.ok(overloaded.every((response) => response.headers["retry-after"] === "1"));
    assert.ok(responses.every((response) => response.statusCode === 200 || response.statusCode === 503));
  } finally {
    workerThreads.Worker = original;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("thumbnails: render workers are reused instead of started for every photo", async () => {
  const instance = await start();
  const original = workerThreads.Worker;
  let spawned = 0;
  class CountedWorker extends original {
    constructor(...args: ConstructorParameters<typeof original>) {
      super(...args);
      spawned++;
    }
  }
  try {
    const client = await member(instance, "thumbnail-reuse");
    const nodes = await sentPhotos(client, 12);
    workerThreads.Worker = CountedWorker;
    syncBuiltinESMExports();
    for (const node of nodes) assert.equal((await get(client, urls.nodeThumbnail(node.id))).statusCode, 200);
    assert.equal(spawned, 1);
  } finally {
    workerThreads.Worker = original;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("thumbnails: failed image renders are cached and TIFF is not admitted", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const bad = Buffer.from("not an image");
    const tiff = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .tiff()
      .toBuffer();
    const { result } = await send(client, [
      { path: "broken.png", data: bad, mime: "image/png" },
      { path: "photo.tiff", data: bad, mime: "image/tiff" },
      { path: "disguised.jpg", data: tiff, mime: "image/jpeg" },
    ]);
    const nodes = new Map(
      (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.map((n) => [n.name, n]),
    );
    const broken = nodes.get("broken.png")!;
    assert.equal((await get(client, urls.nodeThumbnail(broken.id))).statusCode, 415);
    const marker = join(instance.root, "thumbnails", `${sha(bad)}-image.failed`);
    assert.equal(existsSync(marker), true);
    assert.equal((await get(client, urls.nodeThumbnail(broken.id))).statusCode, 415);
    assert.equal((await get(client, urls.nodeThumbnail(nodes.get("photo.tiff")!.id))).statusCode, 415);
    assert.equal((await get(client, urls.nodeThumbnail(nodes.get("disguised.jpg")!.id))).statusCode, 415);
    await client.call(api.items.trash, { params: { id: result.itemId } });
    await client.call(api.items.remove, { params: { id: result.itemId } });
    assert.equal(existsSync(marker), false, "collecting the blob removes its cached failure");
  } finally {
    await instance.close();
  }
});

test("thumbnails: only real PNG, JPEG, GIF, WebP and HEIF bytes reach a decoder, whatever the name says", async () => {
  const pixel = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "teal" } });
  const real = {
    png: await pixel().png().toBuffer(),
    jpeg: await pixel().jpeg().toBuffer(),
    gif: await pixel().gif().toBuffer(),
    webp: await pixel().webp().toBuffer(),
    heif: await pixel().avif().toBuffer(),
  };
  for (const [format, data] of Object.entries(real)) assert.equal(imageSignature(data), format);
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
  );
  const tiff = await pixel().tiff().toBuffer();
  for (const other of [svg, tiff, Buffer.from("GIF8"), Buffer.alloc(0)]) assert.equal(imageSignature(other), null);

  const instance = await start();
  try {
    const client = await member(instance, "decoder-owner");
    const { result } = await send(client, [
      ...Object.entries(real).map(([format, data]) => ({ path: `real.${format === "heif" ? "avif" : format}`, data })),
      { path: "drawing.png", data: svg, mime: "image/png" },
      { path: "drawing.heic", data: Buffer.concat([svg, Buffer.from(" ")]), mime: "image/heic" },
    ]);
    const nodes = new Map(
      (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.map((n) => [n.name, n]),
    );
    for (const name of ["real.png", "real.jpeg", "real.gif", "real.webp", "real.avif"])
      assert.equal((await get(client, urls.nodeThumbnail(nodes.get(name)!.id))).statusCode, 200, name);
    assert.equal((await get(client, urls.nodeThumbnail(nodes.get("drawing.png")!.id))).statusCode, 415);
    assert.equal(
      (await get(client, urls.nodeThumbnail(nodes.get("drawing.heic")!.id))).statusCode,
      415,
      "nor with a HEIF name",
    );
  } finally {
    await instance.close();
  }
});

for (const concurrent of [false, true]) {
  test(`thumbnail decoder failures do not poison a valid alias (${concurrent ? "concurrent" : "cached"})`, async () => {
    const instance = await start();
    const original = workerThreads.Worker;
    let began!: () => void;
    const rendering = new Promise<void>((resolve) => (began = resolve));
    class ObservedWorker extends original {
      postMessage(job: { format?: string }) {
        if (job.format === "heif") began();
        super.postMessage(job);
      }
    }
    try {
      const client = await member(instance, "thumbnail-decoder-owner");
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
        .png()
        .toBuffer();
      const { result } = await send(client, [
        { path: "alias.heic", data: png, mime: "image/heic" },
        { path: "valid.png", data: png, mime: "image/png" },
      ]);
      const nodes = new Map(
        (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.map((node) => [node.name, node]),
      );
      workerThreads.Worker = ObservedWorker;
      syncBuiltinESMExports();
      const wrong = get(client, urls.nodeThumbnail(nodes.get("alias.heic")!.id));
      await rendering;
      if (!concurrent) assert.equal((await wrong).statusCode, 415);
      const valid = get(client, urls.nodeThumbnail(nodes.get("valid.png")!.id));
      const [wrongResult, validResult] = await Promise.all([wrong, valid]);
      assert.equal(wrongResult.statusCode, 415);
      assert.equal(validResult.statusCode, 200);
      assert.equal((await sharp(validResult.rawPayload).metadata()).format, "webp");
      assert.equal(existsSync(join(instance.root, "thumbnails", `${sha(png)}-heif.failed`)), true);
      assert.equal(existsSync(join(instance.root, "thumbnails", `${sha(png)}-image.failed`)), false);
      assert.equal((await get(client, urls.nodeThumbnail(nodes.get("valid.png")!.id, "l"))).statusCode, 200);
      await client.call(api.items.trash, { params: { id: result.itemId } });
      await client.call(api.items.remove, { params: { id: result.itemId } });
      assert.equal(existsSync(join(instance.root, "thumbnails", `${sha(png)}-heif.failed`)), false);
    } finally {
      workerThreads.Worker = original;
      syncBuiltinESMExports();
      await instance.close();
    }
  });
}

test("thumbnails: a tiny AVIF of huge dimensions isn't decoded, and an image Relay stopped during twice isn't retried", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "avif-owner");
    const flat = (width: number) => sharp({ create: { width, height: 4000, channels: 3, background: "#888" } });
    // A few hundred bytes that would take over 200 MB to decode, named like a PNG.
    const huge = await flat(4100).avif({ quality: 1, effort: 0 }).toBuffer();
    const photo = await flat(10).png().toBuffer();
    const { result } = await send(client, [
      { path: "huge.png", data: huge, mime: "image/png" },
      { path: "photo.png", data: photo, mime: "image/png" },
    ]);
    const nodes = new Map(
      (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.map((n) => [n.name, n]),
    );
    assert.equal((await get(client, urls.nodeThumbnail(nodes.get("huge.png")!.id))).statusCode, 415);
    assert.ok(existsSync(join(instance.root, "thumbnails", `${sha(huge)}-image.failed`)));

    // As if Relay had been stopped during this image's render once, then again.
    const note = join(instance.root, "thumbnails", `${sha(photo)}-image.rendering`);
    writeFileSync(note, "0");
    const url = urls.nodeThumbnail(nodes.get("photo.png")!.id);
    assert.equal((await get(client, url, {}, "HEAD")).statusCode, 200, "one stop may have been anything");
    assert.equal(existsSync(note), false, "a finished render clears its note");
    await unlink(join(instance.root, "thumbnails", `${sha(photo)}-s.webp`));
    writeFileSync(note, "1");
    assert.equal((await get(client, url)).statusCode, 415);
    assert.ok(existsSync(join(instance.root, "thumbnails", `${sha(photo)}-image.failed`)));
    assert.equal(existsSync(note), false);
  } finally {
    await instance.close();
  }
});

/** A small progressive JPEG with its last scan repeated: damaged, and as many scans as asked for. */
async function rescanned(copies: number) {
  const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#4a8" } })
    .jpeg({ progressive: true })
    .toBuffer();
  const scan = jpeg.lastIndexOf(Buffer.from([0xff, 0xda]));
  const end = jpeg.length - 2;
  return Buffer.concat([
    jpeg.subarray(0, end),
    ...Array<Buffer>(copies).fill(jpeg.subarray(scan, end)),
    jpeg.subarray(end),
  ]);
}

test("thumbnails: an image too costly to decode is refused from its header, and damaged ones aren't retried", async () => {
  const flat = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 0.5 } } })
      .png()
      .toBuffer();
  // A row wider than 128 KiB: tiny as a file, but shrinking it needs memory that grows with the row.
  const wide = await flat(32_769, 1);
  const widest = await flat(32_768, 1);
  const avif = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#4a8" } })
    .avif()
    .toBuffer();
  const tooManyScans = await rescanned(120);
  // The marker walk sees what libjpeg would allocate, without decoding anything.
  const layout = jpegLayout(tooManyScans);
  assert.equal(layout.scans, 130);
  assert.equal(layout.wholeImage, true);
  assert.match(decodeRefusal(await sharp(tooManyScans).metadata(), layout)!, /too many scans/);
  // A flat 3200 × 3200 AVIF from sharp with a clean-aperture crop to 64 × 64 added to its image, as
  // scripts/verify-thumbnails.ts makes them: sharp reports 64 × 64, but the whole frame is decoded.
  const cropped = Buffer.from(
    [
      "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAAP9tZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAA",
      "ACJpbG9jAAAAAERAAAEAAQAAAAABIwABAAAAAAAAAYIAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRt",
      "AAAAAAABAAAAf2lwcnAAAABgaXBjbwAAAAxhdjFDgTACAAAAABRpc3BlAAAAAAAADIAAAAyAAAAAEHBpeGkAAAAAAwgICAAAAChj",
      "bGFwAAAAQAAAAAEAAABAAAAAAQAAAAAAAAABAAAAAAAAAAEAAAAXaXBtYQAAAAAAAAABAAEEgQIDBAAAAYptZGF0EgAKCjwu8f8f",
      "2kBDQaQy8QIaTEJi5OmmmmFjYEAATM/KKvXve1M3I/1+csTzY3v2dpf81mYykpSRtL2fLlvNfaTmwiDxCywtdxfxEIv7WmqfcFCF",
      "4WSzeeIJlDBwltmELe5huNFUO7R2W9DxXc/KR4IPck3ZDNzUBJtdyJWwOOeZMaBVTjSKAfXgfRcQDDfWQ6oWym8Szs3SriJuBqiX",
      "EafnV8uRd1sMLSreaD5m2EMc5rUAJ06uBYXRiW2Az+wnrFGD/qC1Jrzmm4xdz8pHgg9yTdkM3Fh+jt2y4i7WcXXtzfmE+rMkwnsu",
      "L3hP5TBw4XnNObpMB+nS5y89/aP5JVdIpkBSnzU2KiUzsGjOIAVLBjzBsrAhfGD3rjb7ZGpFQzD08E64QgHitM/KR32zybu+t04r",
      "fvaSaBs8PuB7LIyHSaqrV8qoMlz0RVWx3I/ff3i4eeoHJZTwOqO8kDNaJpUI4Av6dixw/ZS+pwaeCvxeLq8ZAy6JX6XnIoii+T+V",
      "iPA=",
    ].join(""),
    "base64",
  );
  const croppedMetadata = await sharp(cropped).metadata();
  assert.deepEqual([croppedMetadata.width, croppedMetadata.height], [64, 64]);
  assert.deepEqual(heifLayout(cropped), {
    width: 3200,
    height: 3200,
    side: 3200,
    derived: false,
    overlay: false,
    eightBitAv1: false,
  });
  assert.match(decodeRefusal(croppedMetadata, null, heifLayout(cropped))!, /too large/);
  assert.equal(decodeRefusal(await sharp(avif).metadata(), null, heifLayout(avif)), null);
  assert.equal(heifLayout(avif.subarray(0, 40)), null, "a damaged structure isn't guessed at");

  const instance = await start();
  try {
    const client = await member(instance, "costly-owner");
    const files = {
      "wide.png": wide,
      "widest.png": widest,
      "scans.jpg": tooManyScans,
      // Damaged files whose decoder errors used to look temporary, so they were retried on every look.
      "progression.jpg": await rescanned(3),
      "truncated.avif": avif.subarray(0, avif.length - 40),
      "cropped.avif": cropped,
    };
    const { result } = await send(
      client,
      Object.entries(files).map(([path, data]) => ({ path, data })),
    );
    const nodes = new Map(
      (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.map((n) => [n.name, n]),
    );
    assert.equal((await get(client, urls.nodeThumbnail(nodes.get("widest.png")!.id))).statusCode, 200);
    for (const name of ["wide.png", "scans.jpg", "progression.jpg", "truncated.avif", "cropped.avif"]) {
      assert.equal((await get(client, urls.nodeThumbnail(nodes.get(name)!.id))).statusCode, 415, name);
      const data = files[name as keyof typeof files];
      assert.ok(existsSync(join(instance.root, "thumbnails", `${sha(data)}-image.failed`)), `${name} is never retried`);
    }
  } finally {
    await instance.close();
  }
});

test("thumbnails: a 12 MP phone AVIF previews, judged by its AV1 stream rather than the boxes describing it", async () => {
  const avif = (channels: 3 | 4, options: AvifOptions) =>
    sharp({ create: { width: 4000, height: 3000, channels, background: { r: 9, g: 99, b: 9, alpha: 0.5 } } })
      .avif({ quality: 1, effort: 0, ...options })
      .toBuffer();
  const refusal = async (data: Buffer) => decodeRefusal(await sharp(data).metadata(), null, heifLayout(data));
  const phone = await avif(3, { chromaSubsampling: "4:2:0" });
  assert.equal(heifLayout(phone)!.eightBitAv1, true);
  assert.equal(await refusal(phone), null);
  // Deeper colour, full-resolution colour and transparency each need more memory a pixel.
  const deep = await avif(3, { chromaSubsampling: "4:2:0", bitdepth: 10 });
  assert.match((await refusal(deep))!, /too large/);
  assert.match((await refusal(await avif(3, { chromaSubsampling: "4:4:4" })))!, /too large/);
  assert.match((await refusal(await avif(4, { chromaSubsampling: "4:2:0" })))!, /too large/);
  // A 10-bit stream whose `av1C` property claims 8 bits is still decoded at 10.
  const relabelled = Buffer.from(deep);
  const av1C = relabelled.indexOf("av1C", 0, "latin1") + 4;
  relabelled[av1C + 2] &= 0b1011_1111; // high_bitdepth
  assert.equal((await sharp(relabelled).metadata()).depth, "uchar");
  assert.match((await refusal(relabelled))!, /too large/);
});

test("thumbnails: a HEIC is judged by the whole of what libheif decodes, not the crop it reports", async () => {
  const refusal = (options: Parameters<typeof heic>[0]) => heicRefusal(heifLayout(heic(options)));
  // A phone photo is a grid of tiles; its canvas is in the grid's data, here in `idat` as Apple writes it.
  const photo = heifLayout(heic({ grid: { columns: 2, rows: 2, ispe: [1024, 1024], inIdat: true } }));
  assert.deepEqual(photo, { width: 1024, height: 1024, side: 1024, derived: true, overlay: false, eightBitAv1: false });
  assert.equal(heicRefusal(photo), null);
  // The reported repro: a 64 × 64 crop of a 32768 × 32768 grid, in a few hundred bytes.
  const huge: [number, number] = [32_768, 32_768];
  assert.match(refusal({ grid: { columns: 1, rows: 1, canvas: huge, ispe: [64, 64] }, clap: [64, 64] })!, /too large/);
  // A grid canvas with no size property at all.
  assert.match(refusal({ ispe: null, grid: { columns: 1, rows: 1, canvas: [6000, 6000] } })!, /too large/);
  // libde265 allocates the frame its parameter sets describe, wherever they are.
  assert.equal(heifLayout(heic({ ispe: [1, 1], sps: hevcSps(512, 512, 3) }))!.width, 512);
  assert.match(refusal({ ispe: [64, 64], sps: hevcSps(8192, 8192, 2) })!, /too large/);
  assert.match(refusal({ ispe: [64, 64], inband: [hevcSps(8192, 8192)] })!, /too large/);
  assert.match(refusal({ ispe: [64, 64], sps: hevcSps(70_000, 3) })!, /too large/, "however thin");
  assert.match(refusal({ overlay: true })!, /layers/);
  assert.match(heicRefusal(heifLayout(heic().subarray(0, 200)))!, /damaged/);

  const instance = await start();
  try {
    const client = await member(instance, "heic-owner");
    // 26 MP of tiles shown as a 64 × 64 crop: libheif reports 64 × 64, then decodes all 26 MP.
    const cropped = heic({ grid: { columns: 10, rows: 10, ispe: [5120, 5120] }, clap: [64, 64] });
    const small = heic({ grid: { columns: 2, rows: 1, ispe: [1024, 512] } });
    const { result } = await send(client, [
      { path: "holiday.heic", data: cropped },
      { path: "small.heic", data: small },
    ]);
    const nodes = new Map(
      (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.map((n) => [n.name, n]),
    );
    const preview = await get(client, urls.nodeThumbnail(nodes.get("small.heic")!.id));
    assert.equal(preview.statusCode, 200);
    assert.equal((await sharp(preview.rawPayload).metadata()).format, "webp");
    assert.equal((await get(client, urls.nodeThumbnail(nodes.get("holiday.heic")!.id))).statusCode, 415);
    assert.ok(existsSync(join(instance.root, "thumbnails", `${sha(cropped)}-heif.failed`)));
  } finally {
    await instance.close();
  }
});

test("thumbnails: an image that times out twice isn't tried again, so it can't hold up every preview", async (t) => {
  const instance = await start();
  const original = workerThreads.Worker;
  let posted = 0;
  /**
   * A worker that never gets as far as decoding the first job, as when the machine is busy, then
   * starts decoding the next two and never finishes, as with a decode that takes too long.
   */
  class SlowWorker extends EventEmitter {
    postMessage(job: { id: number }) {
      posted++;
      if (posted === 1) return;
      queueMicrotask(() =>
        this.emit(
          "message",
          posted > 3 ? { id: job.id, ok: false, code: "RENDER_FAILED" } : { id: job.id, decoding: true },
        ),
      );
    }
    unref() {}
    terminate() {
      return Promise.resolve(1);
    }
  }
  let before = 0;
  const asked = async () => {
    while (posted === before) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const client = await member(instance, "slow-owner");
    const png = await sharp({ create: { width: 30, height: 30, channels: 3, background: "teal" } })
      .png()
      .toBuffer();
    const { result } = await send(client, [{ path: "slow.png", data: png, mime: "image/png" }]);
    const node = (await client.call(api.items.get, { params: { id: result.itemId } })).nodes[0];
    const url = urls.nodeThumbnail(node.id);
    const note = join(instance.root, "thumbnails", `${sha(png)}-image.rendering`);
    workerThreads.Worker = SlowWorker as unknown as typeof original;
    syncBuiltinESMExports();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });

    for (const strike of [null, "0", "1"]) {
      before = posted;
      const response = get(client, url);
      await asked();
      t.mock.timers.tick(15_000);
      assert.equal((await response).statusCode, 503);
      if (strike === null) assert.equal(existsSync(note), false, "a worker slow to start isn't the image's fault");
      else assert.equal(readFileSync(note, "utf8"), strike, "a decode cut short by the time limit keeps its note");
      t.mock.timers.tick(RENDITION_RETRY_MS + 1);
    }
    const last = await get(client, url);
    assert.equal(last.statusCode, 415);
    assert.equal(posted, 3, "not decoded a third time");
    assert.ok(existsSync(join(instance.root, "thumbnails", `${sha(png)}-image.failed`)));
  } finally {
    workerThreads.Worker = original;
    syncBuiltinESMExports();
    t.mock.timers.reset();
    await instance.close();
  }
});

test("thumbnail worker outages return 503 with bounded backoff and recover without persistent failure markers", async (t) => {
  const instance = await start();
  const original = workerThreads.Worker;
  let attempted = 0;
  class FailingWorker extends EventEmitter {
    constructor() {
      super();
      attempted++;
      queueMicrotask(() => this.emit("error", new Error("temporary worker I/O failure")));
    }
    postMessage() {}
    terminate() {
      return Promise.resolve(1);
    }
  }
  try {
    const client = await member(instance, "thumbnail-retry-owner");
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const { result } = await send(client, [{ path: "photo.png", data: png, mime: "image/png" }]);
    const node = (await client.call(api.items.get, { params: { id: result.itemId } })).nodes[0];
    const url = urls.nodeThumbnail(node.id);
    workerThreads.Worker = FailingWorker as unknown as typeof original;
    syncBuiltinESMExports();
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const first = await get(client, url);
    assert.equal(first.statusCode, 503);
    assert.equal(first.headers["retry-after"], "5");
    assert.equal(existsSync(join(instance.root, "thumbnails", `${sha(png)}-image.failed`)), false);
    assert.equal((await get(client, urls.nodeThumbnail(node.id, "l"))).statusCode, 503);
    assert.equal(attempted, 1, "both sizes share transient backoff");
    workerThreads.Worker = original;
    syncBuiltinESMExports();
    t.mock.timers.tick(RENDITION_RETRY_MS + 1);
    // An unclassified failure marker cannot poison the decoder-scoped failure cache.
    writeFileSync(join(instance.root, "thumbnails", `${sha(png)}.failed`), "old unclassified failure");
    assert.equal((await get(client, url)).statusCode, 200);
  } finally {
    workerThreads.Worker = original;
    syncBuiltinESMExports();
    t.mock.timers.reset();
    await instance.close();
  }
});
