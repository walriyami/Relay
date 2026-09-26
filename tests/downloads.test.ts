import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { api, urls } from "../shared/api.ts";
import { MAX_QUEUED_RENDITIONS } from "../server/modules/downloads/thumbnails.ts";
import { Client, member, send, start } from "./support/harness.ts";

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
    assert.equal((await get(client, urls.nodeContent(node.id))).statusCode, 500);
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

test("thumbnails: unique rendition backlog is bounded and rejected with a retry hint", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "thumbnail-queue-owner");
    const files = await Promise.all(
      Array.from({ length: MAX_QUEUED_RENDITIONS + 2 }, async (_, index) => ({
        path: `images/${index}.png`,
        mime: "image/png",
        data: await sharp({
          create: { width: 256, height: 256, channels: 3, background: { r: index * 7, g: index * 3, b: index } },
        })
          .png()
          .toBuffer(),
      })),
    );
    const { result } = await send(client, files);
    const nodes = (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.filter(
      (node) => node.kind === "file",
    );

    const responses = await Promise.all(nodes.map((node) => get(client, urls.nodeThumbnail(node.id))));
    const overloaded = responses.filter((response) => response.statusCode === 503);
    assert.ok(overloaded.length > 0, "excess distinct renditions are rejected rather than queued without bound");
    assert.ok(overloaded.every((response) => response.headers["retry-after"] === "1"));
    assert.ok(responses.every((response) => response.statusCode === 200 || response.statusCode === 503));
  } finally {
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
    const marker = join(instance.root, "thumbnails", `${sha(bad)}.failed`);
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
