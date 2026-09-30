import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { request } from "node:http";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { api, urls } from "../shared/api.ts";
import { DAY_MS } from "../server/lib/time.ts";

// Hold one real password derivation's completion at an authorization/write boundary.
// Installing before importing the harness lets secrets.ts capture the controlled callback.
const nativeScrypt = crypto.scrypt;
let heldHash: null | { started: () => void; release: Promise<void> } = null;
crypto.scrypt = (...args: unknown[]) => {
  const callback = args.pop() as (...result: unknown[]) => void;
  const held = heldHash;
  heldHash = null;
  held?.started();
  return (nativeScrypt as (...values: unknown[]) => void)(...args, (...result: unknown[]) => {
    if (held) void held.release.then(() => callback(...result));
    else callback(...result);
  });
};
syncBuiltinESMExports();
const { ApiError, Client, member, patchUpload, send, start } = await import("./support/harness.ts");
const { Stream } = await import("./support/event-stream.ts");
type Client = InstanceType<typeof Client>;
type Instance = Awaited<ReturnType<typeof start>>;

const rejected = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};
const manifest = (client: Client, path = "pending.bin", size = 4) => ({
  id: crypto.randomUUID(),
  tab: client.tab,
  name: null,
  folders: [],
  files: [{ path, size, mime: "application/octet-stream" }],
});
const guestManifest = (client: Client, path = "submission.bin", size = 4) => ({
  id: crypto.randomUUID(),
  tab: client.tab,
  folders: [],
  files: [{ path, size, mime: "application/octet-stream" }],
});
const intake = (owner: Client, name: string, maxBytes = 100) =>
  owner.call(api.requests.create, {
    body: { id: crypto.randomUUID(), name, description: "Private intake", days: 1, maxBytes },
  });
const guest = async (instance: Instance, token: string) => {
  const browser = new Client(instance);
  await browser.call(api.requests.start, { params: { token } });
  return browser;
};
const bytes = (client: Client, url: string, method: "GET" | "HEAD" = "GET", headers: Record<string, string> = {}) =>
  client.raw({ method, url, headers });

async function networkPatch(base: string, client: Client, id: string, data: Buffer) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      `${base}/uploads/${id}`,
      {
        method: "PATCH",
        agent: false,
        headers: {
          host: "relay.test",
          cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          "x-relay-csrf": client.csrf,
          "tus-resumable": "1.0.0",
          "upload-offset": "0",
          "content-type": "application/offset+octet-stream",
          "content-length": String(data.length),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString() }));
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(data);
  });
}

test("content audit: member identifiers do not grant cross-owner read or mutation authority", async () => {
  const instance = await start();
  try {
    const alice = await member(instance, "content-alice");
    const bob = await member(instance, "content-bob");
    const own = await send(alice, [{ path: "Alice/private.txt", data: "ALICE PRIVATE" }], {
      text: "Alice hidden text",
      destination: { kind: "link", days: 1 },
    });
    const other = await send(bob, [{ path: "Bob/public.txt", data: "BOB OWN" }]);
    const detail = await alice.call(api.items.get, { params: { id: own.result.itemId } });
    const node = detail.nodes.find((n) => n.kind === "file")!;
    const waiting = await alice.call(api.transfers.create, { body: manifest(alice) });
    const upload = waiting.uploads[0].id;
    const request = await intake(alice, "Alice request");
    const id = own.result.itemId;
    for (const [method, url, payload] of [
      ["GET", `/api/items/${id}`, undefined],
      ["PATCH", `/api/items/${id}`, { name: "stolen" }],
      ["POST", `/api/items/${id}/trash`, undefined],
      ["POST", `/api/items/${id}/restore`, undefined],
      ["DELETE", `/api/items/${id}`, undefined],
      ["PATCH", `/api/links/${own.result.link!.id}`, { note: "stolen" }],
      ["GET", `/api/links/${own.result.link!.id}/visits`, undefined],
      ["DELETE", `/api/links/${own.result.link!.id}`, undefined],
      ["PATCH", `/api/requests/${request.id}`, { name: "stolen", description: "", days: null, maxBytes: 100 }],
      ["GET", `/api/requests/${request.id}/submissions`, undefined],
      ["DELETE", `/api/requests/${request.id}`, undefined],
      ["POST", `/api/transfers/${waiting.id}/complete`, { destination: { kind: "save" } }],
      ["POST", `/api/transfers/${waiting.id}/cancel`, undefined],
      ["DELETE", `/api/uploads/${upload}`, undefined],
      ["POST", `/api/tabs/${alice.tab}/close`, undefined],
    ] as const) {
      const response = await bob.raw({ method, url, ...(payload ? { payload } : {}) });
      assert.equal(response.statusCode, 404, `${method} ${url}: ${response.body}`);
      assert.equal(response.body.includes("ALICE PRIVATE"), false);
    }
    for (const method of ["GET", "HEAD"] as const)
      for (const url of [urls.nodeContent(node.id), urls.nodeThumbnail(node.id), urls.itemZip(id)]) {
        const response = await bytes(bob, url, method, { range: "bytes=0-1", "if-none-match": '"guessed"' });
        assert.equal(response.statusCode, 404, `${method} ${url}`);
        assert.equal(response.headers.etag, undefined, "unauthorized requests do not reveal content hashes");
        assert.equal(response.headers["content-disposition"], undefined);
      }
    assert.equal((await bytes(bob, `/uploads/${upload}`, "HEAD")).statusCode, 404);
    assert.equal((await patchUpload(bob, upload, 0, Buffer.from("EVIL"))).statusCode, 404);
    await assert.rejects(bob.call(api.transfers.create, { body: { ...manifest(bob), item: id } }), rejected(404));
    await assert.rejects(
      bob.call(api.links.create, { body: { id: crypto.randomUUID(), item: id, days: 1 } }),
      rejected(404),
    );
    await assert.rejects(
      bob.call(api.items.bulk, { body: { operation: "trash", ids: [other.result.itemId, id] } }),
      rejected(404),
    );
    assert.equal((await bob.call(api.items.get, { params: { id: other.result.itemId } })).trashed, null);
    assert.equal((await alice.call(api.items.get, { params: { id } })).trashed, null);
    assert.equal((await bytes(alice, urls.nodeContent(node.id))).body, "ALICE PRIVATE");
    assert.equal((await bytes(alice, `/uploads/${upload}`, "HEAD")).headers["upload-offset"], "0");
    const bobItems = await bob.call(api.items.list, { query: { q: "Alice" } });
    assert.equal(bobItems.total, 0);
    assert.deepEqual(await bob.call(api.links.list), []);
    assert.deepEqual(await bob.call(api.requests.list), []);
    assert.deepEqual(await bob.call(api.deliveries.list), []);
    assert.equal(JSON.stringify(await bob.call(api.activity.list)).includes(id), false);
    assert.equal(JSON.stringify(await bob.call(api.usage)).includes(id), false);
  } finally {
    await instance.close();
  }
});

test("content audit: identical deduplicated bytes retain independent member and share authority", async () => {
  const instance = await start();
  try {
    const alice = await member(instance, "dedup-alice");
    const bob = await member(instance, "dedup-bob");
    const payload = "identical but independently authorized";
    const a = await send(alice, [{ path: "a.txt", data: payload }], { destination: { kind: "link", days: 1 } });
    const b = await send(bob, [{ path: "b.txt", data: payload }]);
    const an = (await alice.call(api.items.get, { params: { id: a.result.itemId } })).nodes[0];
    const bn = (await bob.call(api.items.get, { params: { id: b.result.itemId } })).nodes[0];
    const blobs = instance.ctx.db.all<{ blob: string }>("SELECT DISTINCT blob FROM nodes WHERE kind = 'file'");
    assert.equal(blobs.length, 1, "the positive control exercises physical deduplication");
    assert.notEqual(an.id, bn.id);
    assert.equal((await bytes(bob, urls.nodeContent(an.id))).statusCode, 404);
    assert.equal((await bytes(alice, urls.nodeContent(bn.id))).statusCode, 404);
    const visitor = new Client(instance);
    assert.equal((await bytes(visitor, urls.shareContent(a.result.link!.token, bn.id))).statusCode, 404);
    assert.equal((await bytes(visitor, urls.shareContent(a.result.link!.token, an.id))).body, payload);
    await alice.call(api.items.trash, { params: { id: a.result.itemId } });
    await alice.call(api.items.remove, { params: { id: a.result.itemId } });
    assert.equal(
      (await bytes(bob, urls.nodeContent(bn.id))).body,
      payload,
      "purging one reference retains the other's bytes",
    );
    assert.equal((await bytes(visitor, urls.shareContent(a.result.link!.token, an.id))).statusCode, 404);
    assert.equal((await bob.call(api.usage)).storage.used, Buffer.byteLength(payload));
  } finally {
    await instance.close();
  }
});

test("content audit: password, visitor and revocation gates apply to all share representations", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "gate-owner");
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const saved = await send(owner, [{ path: "Folder/photo.png", data: png, mime: "image/png" }], {
      destination: { kind: "link", days: 1, password: "first-password", visitorLimit: 1 },
    });
    const link = saved.result.link!;
    const detail = await owner.call(api.items.get, { params: { id: saved.result.itemId } });
    const node = detail.nodes.find((n) => n.kind === "file")!;
    const paths = [
      urls.shareContent(link.token, node.id),
      urls.shareThumbnail(link.token, node.id),
      urls.shareZip(link.token),
    ];
    const admitted = new Client(instance);
    const stranger = new Client(instance);
    assert.deepEqual(await admitted.call(api.links.open, { params: { token: link.token } }), {
      locked: true,
      from: "gate-owner",
    });
    for (const method of ["GET", "HEAD"] as const)
      for (const url of paths)
        assert.equal((await bytes(admitted, url, method, { range: "bytes=0-1" })).statusCode, 401);
    await assert.rejects(
      admitted.call(api.links.unlock, { params: { token: link.token }, body: { password: "wrong" } }),
      rejected(403),
    );
    await admitted.call(api.links.unlock, { params: { token: link.token }, body: { password: "first-password" } });
    const thumbnail = await bytes(admitted, paths[1]);
    assert.equal(thumbnail.statusCode, 200);
    for (const url of paths) assert.equal((await bytes(admitted, url, "HEAD")).statusCode, 200);
    await assert.rejects(stranger.call(api.links.open, { params: { token: link.token } }), rejected(410));
    await owner.call(api.links.update, { params: { id: link.id }, body: { password: "second-password" } });
    for (const url of paths)
      assert.equal(
        (await bytes(admitted, url, "GET", { "if-none-match": String(thumbnail.headers.etag) })).statusCode,
        401,
      );
    await assert.rejects(
      admitted.call(api.links.unlock, { params: { token: link.token }, body: { password: "first-password" } }),
      rejected(403),
    );
    await admitted.call(api.links.unlock, { params: { token: link.token }, body: { password: "second-password" } });
    assert.equal(
      (await bytes(admitted, paths[1], "GET", { "if-none-match": String(thumbnail.headers.etag) })).statusCode,
      304,
    );
    await owner.call(api.links.revoke, { params: { id: link.id } });
    for (const method of ["GET", "HEAD"] as const)
      for (const url of paths)
        assert.equal(
          (await bytes(admitted, url, method, { "if-none-match": String(thumbnail.headers.etag) })).statusCode,
          404,
        );
    assert.equal(
      (await bytes(owner, urls.nodeContent(node.id))).statusCode,
      200,
      "the owner retains independent access",
    );
  } finally {
    await instance.close();
  }
});

test("content audit: guest cookies and submitted identifiers cannot cross request or owner boundaries", async () => {
  const instance = await start();
  try {
    const alice = await member(instance, "intake-alice");
    const bob = await member(instance, "intake-bob");
    const ar = await intake(alice, "Alice intake");
    const br = await intake(bob, "Bob intake");
    const a = await guest(instance, ar.token);
    const b = await guest(instance, br.token);
    await assert.rejects(
      a.call(api.requests.transfer, { params: { token: br.token }, body: guestManifest(a) }),
      rejected(401),
    );
    const forged = new Client(instance);
    forged.csrf = a.csrf;
    const heldCookie = [...a.cookies.entries()].find(([name]) => name.includes("relay_guest_"))!;
    forged.cookies.set(heldCookie[0].replace(ar.id, br.id), heldCookie[1]);
    await assert.rejects(
      forged.call(api.requests.transfer, { params: { token: br.token }, body: guestManifest(forged) }),
      rejected(401),
    );
    const privateItem = await send(alice, [{ path: "private.txt", data: "not guest writable" }]);
    const created = await a.raw({
      method: "POST",
      url: `/api/r/${ar.token}/transfers`,
      payload: {
        ...guestManifest(a),
        item: privateItem.result.itemId,
        owner: (await bob.call(api.session.get)).user.id,
        text: "injected text",
        retentionDays: null,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const transfer = created.json<{ id: string; itemId: string; uploads: { id: string }[] }>();
    assert.notEqual(transfer.itemId, privateItem.result.itemId, "unknown fields do not override the server's target");
    assert.equal(instance.ctx.db.value("SELECT request_id FROM items WHERE id = ?", transfer.itemId), ar.id);
    assert.equal(
      instance.ctx.db.value("SELECT count(*) FROM nodes WHERE item = ? AND kind = 'text'", transfer.itemId),
      0,
    );
    const upload = transfer.uploads[0].id;
    assert.equal((await bytes(b, `/uploads/${upload}`, "HEAD")).statusCode, 404);
    assert.equal((await patchUpload(b, upload, 0, Buffer.from("EVIL"))).statusCode, 404);
    await assert.rejects(b.call(api.transfers.cancel, { params: { id: transfer.id } }), rejected(404));
    assert.equal((await patchUpload(a, upload, 0, Buffer.from("GOOD"))).statusCode, 204);
    await assert.rejects(
      a.call(api.transfers.complete, { params: { id: transfer.id }, body: { destination: { kind: "link", days: 1 } } }),
      rejected(403),
    );
    await assert.rejects(
      a.call(api.transfers.complete, {
        params: { id: transfer.id },
        body: { destination: { kind: "device", device: (await alice.call(api.session.get)).device.id } },
      }),
      rejected(403),
    );
    await a.call(api.transfers.complete, { params: { id: transfer.id }, body: { destination: { kind: "save" } } });
    const [submission] = await alice.call(api.requests.submissions, { params: { id: ar.id } });
    assert.equal(submission.id, transfer.itemId);
    const node = (await alice.call(api.items.get, { params: { id: transfer.itemId } })).nodes[0];
    for (const url of [`/api/items/${transfer.itemId}`, urls.nodeContent(node.id), urls.itemZip(transfer.itemId)])
      assert.equal((await bytes(a, url)).statusCode, 401, "guest authority is write-only");
    assert.equal((await bytes(alice, urls.nodeContent(node.id))).body, "GOOD");
    assert.equal((await bytes(bob, urls.nodeContent(node.id))).statusCode, 404);
    const incomplete = await a.call(api.requests.transfer, {
      params: { token: ar.token },
      body: guestManifest(a, "late.bin"),
    });
    await alice.call(api.requests.close, { params: { id: ar.id } });
    assert.equal((await patchUpload(a, incomplete.uploads[0].id, 0, Buffer.from("LATE"))).statusCode, 401);
    await assert.rejects(a.call(api.requests.start, { params: { token: ar.token } }), rejected(410));
    await assert.rejects(
      a.call(api.requests.transfer, { params: { token: ar.token }, body: guestManifest(a) }),
      rejected(410),
    );
    assert.equal(
      (await bytes(alice, urls.nodeContent(node.id))).body,
      "GOOD",
      "closing intake does not purge a completed submission",
    );
  } finally {
    await instance.close();
  }
});

test("content audit: simultaneous guests cannot oversubscribe intake reservations", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "reserve-owner");
    const target = await intake(owner, "Bounded", 8);
    const a = await guest(instance, target.token);
    const b = await guest(instance, target.token);
    const results = await Promise.allSettled(
      [a, b].map((client) =>
        client.call(api.requests.transfer, {
          params: { token: target.token },
          body: guestManifest(client, "seven.bin", 7),
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const denied = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(denied.reason instanceof ApiError && denied.reason.status === 413);
    assert.equal(
      (await new Client(instance).call(api.requests.open, { params: { token: target.token } })).remainingBytes,
      1,
    );
    const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>;
    await [a, b][results.findIndex((r) => r.status === "fulfilled")].call(api.transfers.cancel, {
      params: { id: winner.value.id },
    });
    assert.equal(
      (await new Client(instance).call(api.requests.open, { params: { token: target.token } })).remainingBytes,
      8,
    );
  } finally {
    await instance.close();
  }
});

test("content audit: only the intended device may answer its owner's delivery", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "delivery-owner");
    const receiver = new Client(instance);
    const receiving = await receiver.signIn("delivery-owner", "Member-password-only", "Receiver");
    const bystander = new Client(instance);
    await bystander.signIn("delivery-owner", "Member-password-only", "Bystander");
    const stranger = await member(instance, "delivery-stranger");
    // Polling presence is a real authenticated device lease, without a test-created delivery row.
    const base = await instance.app.listen({ port: 0, host: "127.0.0.1" });
    const presence = await Stream.open(base, urls.events(receiver.tab), receiver, null);
    await presence.until((events) => events.includes("<closed>"));
    assert.equal(presence.status, 200);
    await presence.close();
    const saved = await send(owner, [{ path: "delivery.txt", data: "for my own device" }]);
    const delivery = await owner.call(api.deliveries.create, {
      body: { id: crypto.randomUUID(), item: saved.result.itemId, device: receiving.device.id },
    });
    for (const unauthorized of [owner, bystander, stranger]) {
      await assert.rejects(
        unauthorized.call(api.deliveries.update, { params: { id: delivery.id }, body: { state: "accepted" } }),
        rejected(404),
      );
      assert.deepEqual(await unauthorized.call(api.deliveries.list, { query: { direction: "incoming" } }), []);
    }
    await assert.rejects(
      owner.call(api.deliveries.create, {
        body: {
          id: crypto.randomUUID(),
          item: saved.result.itemId,
          device: (await stranger.call(api.session.get)).device.id,
        },
      }),
      rejected(404),
    );
    assert.deepEqual(
      await receiver.call(api.deliveries.update, { params: { id: delivery.id }, body: { state: "accepted" } }),
      { state: "accepted", changed: true },
    );
    const node = (await receiver.call(api.items.get, { params: { id: saved.result.itemId } })).nodes[0];
    assert.equal((await bytes(receiver, urls.nodeContent(node.id))).body, "for my own device");
    assert.equal(
      (await bytes(bystander, urls.nodeContent(node.id))).statusCode,
      200,
      "same-account Files access is intentional",
    );
    assert.equal((await bytes(stranger, urls.nodeContent(node.id))).statusCode, 404);
  } finally {
    await instance.close();
  }
});

test("content audit: public image rendition rejects oversized dimensions before pixel allocation", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "pixel-owner");
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    png.writeUInt32BE(10_000, 16);
    png.writeUInt32BE(6_000, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
    const saved = await send(owner, [{ path: "large.png", data: png, mime: "image/png" }], {
      destination: { kind: "link", days: 1 },
    });
    const node = (await owner.call(api.items.get, { params: { id: saved.result.itemId } })).nodes[0];
    const visitor = new Client(instance);
    assert.equal(
      (await bytes(visitor, urls.shareContent(saved.result.link!.token, node.id))).rawPayload.equals(png),
      true,
    );
    const response = await bytes(visitor, urls.shareThumbnail(saved.result.link!.token, node.id));
    assert.equal(response.statusCode, 415, response.body);
    assert.equal((await bytes(visitor, urls.shareThumbnail(saved.result.link!.token, node.id, "l"))).statusCode, 415);
    assert.equal(
      (await bytes(owner, urls.nodeContent(node.id))).statusCode,
      200,
      "one rejected rendition does not take ordinary bytes offline",
    );
  } finally {
    await instance.close();
  }
});

test("content audit: member and guest byte admission share the owner's storage quota", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "quota-owner");
    const user = (await owner.call(api.session.get)).user.id;
    instance.ctx.db.run("UPDATE users SET quota = 6 WHERE id = ?", user);
    const request = await intake(owner, "Quota", 100);
    const visitor = await guest(instance, request.token);
    const pending = await owner.call(api.transfers.create, { body: manifest(owner, "reserved.bin", 4) });
    await assert.rejects(
      visitor.call(api.requests.transfer, {
        params: { token: request.token },
        body: guestManifest(visitor, "more.bin", 3),
      }),
      rejected(413),
    );
    const accepted = await visitor.call(api.requests.transfer, {
      params: { token: request.token },
      body: guestManifest(visitor, "fits.bin", 2),
    });
    assert.equal((await patchUpload(visitor, accepted.uploads[0].id, 0, Buffer.from("ok"))).statusCode, 204);
    await visitor.call(api.transfers.complete, {
      params: { id: accepted.id },
      body: { destination: { kind: "save" } },
    });
    await assert.rejects(owner.call(api.transfers.create, { body: manifest(owner, "overflow.bin", 1) }), rejected(413));
    await owner.call(api.transfers.cancel, { params: { id: pending.id } });
    assert.equal((await owner.call(api.usage)).available, 4);
    const fits = await owner.call(api.transfers.create, { body: manifest(owner, "fits-again.bin", 4) });
    await owner.call(api.transfers.cancel, { params: { id: fits.id } });
    assert.equal(instance.ctx.db.value("SELECT bytes_used FROM users WHERE id = ?", user), 2);
  } finally {
    await instance.close();
  }
});

test("content audit: traversal, ambiguous names, oversized values and query injection do not alter storage", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "input-owner");
    const before = instance.ctx.db.value<number>("SELECT count(*) FROM items")!;
    for (const path of [
      "../outside",
      "/absolute",
      "C:/drive",
      "a/../outside",
      "a\\outside",
      "a//b",
      "a/./b",
      " leading/b",
      "a/../",
      "a/\u0000x",
      "a/\u202eevil",
      "a/\ud800",
    ]) {
      await assert.rejects(owner.call(api.transfers.create, { body: manifest(owner, path) }), rejected(400), path);
    }
    for (const body of [
      { ...manifest(owner), files: [{ path: "x", size: -1 }] },
      { ...manifest(owner), files: [{ path: "x", size: 1.5 }] },
      { ...manifest(owner), files: [{ path: "x", size: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...manifest(owner), tab: "../../uploads" },
      { ...manifest(owner), files: [{ path: "x", size: 1, mime: "x".repeat(121) }] },
    ])
      assert.equal((await owner.raw({ method: "POST", url: "/api/transfers", payload: body })).statusCode, 400);
    await assert.rejects(
      owner.call(api.transfers.create, {
        body: {
          ...manifest(owner),
          files: [
            { path: "a", size: 0, mime: "" },
            { path: "A", size: 0, mime: "" },
          ],
        },
      }),
      rejected(409),
    );
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM items"), before);
    const saved = await send(owner, [{ path: "literal%2f..%2fx.txt", data: "literal" }]);
    const node = (await owner.call(api.items.get, { params: { id: saved.result.itemId } })).nodes[0];
    assert.equal(
      node.name,
      "literal%2f..%2fx.txt",
      "encoded path separators are literal names, never decoded to traversal",
    );
    const archive = await bytes(owner, urls.itemZip(saved.result.itemId));
    assert.equal(archive.statusCode, 200);
    assert.equal(archive.rawPayload.includes(Buffer.from(node.name)), true);
    assert.equal((await owner.call(api.items.list, { query: { q: "' OR 1=1 --" } })).total, 0);
    assert.equal((await owner.raw({ url: "/api/items?sort=name%20DESC%3BDELETE%20FROM%20items" })).statusCode, 400);
    assert.equal((await bytes(owner, "/api/items/%27%20OR%201%3D1--")).statusCode, 404);
    assert.equal((await owner.call(api.items.get, { params: { id: saved.result.itemId } })).nodes[0].id, node.id);
  } finally {
    await instance.close();
  }
});

test("content audit: active MIME declarations are delivered as inert text or attachments", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "mime-owner");
    const payload = '<script>window.__relayAttack=true</script><img src=x onerror="alert(1)">';
    const saved = await send(
      owner,
      [
        { path: "page.html", data: payload, mime: "text/html;charset=UTF-8" },
        {
          path: "image.svg",
          data: `<svg xmlns="http://www.w3.org/2000/svg"><script>${payload}</script></svg>`,
          mime: "image/svg+xml",
        },
        { path: "script.js", data: payload, mime: "application/javascript" },
        { path: "unknown.bin", data: payload, mime: "text/html\r\nX-Evil: injected" },
        { path: "polyglot.jpg", data: payload, mime: "image/jpeg" },
      ],
      { destination: { kind: "link", days: 1 } },
    );
    const nodes = (await owner.call(api.items.get, { params: { id: saved.result.itemId } })).nodes;
    const visitor = new Client(instance);
    for (const node of nodes) {
      const response = await bytes(visitor, urls.shareContent(saved.result.link!.token, node.id, { inline: true }));
      assert.equal(response.statusCode, 200, node.name);
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["x-evil"], undefined);
      if (node.name === "polyglot.jpg") assert.equal(response.headers["content-type"], "image/jpeg");
      else assert.match(String(response.headers["content-type"]), /^text\/plain/);
      assert.match(String(response.headers["content-security-policy"]), /^sandbox;/);
    }
    const raster = nodes.find((n) => n.name === "polyglot.jpg")!;
    assert.equal((await bytes(visitor, urls.shareThumbnail(saved.result.link!.token, raster.id))).statusCode, 415);
    assert.equal(
      (await bytes(visitor, urls.shareThumbnail(saved.result.link!.token, raster.id))).statusCode,
      415,
      "invalid images are rejected without repeating decoder work",
    );
  } finally {
    await instance.close();
  }
});

test("content audit: malformed tus offsets and races never overwrite committed bytes", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "offset-owner");
    const created = await owner.call(api.transfers.create, { body: manifest(owner, "six.bin", 6) });
    const id = created.uploads[0].id;
    for (const offset of ["-1", "1.5", "NaN", "Infinity", "9007199254740992", "0003"]) {
      const response = await owner.raw({
        method: "PATCH",
        url: `/uploads/${id}`,
        headers: {
          "tus-resumable": "1.0.0",
          "upload-offset": offset,
          "content-type": "application/offset+octet-stream",
        },
        payload: Buffer.from("abc"),
      });
      assert.ok([400, 409, 413].includes(response.statusCode), `${offset}: ${response.statusCode}`);
    }
    assert.equal((await bytes(owner, `/uploads/${id}`, "HEAD")).headers["upload-offset"], "0");
    assert.equal((await patchUpload(owner, id, 0, Buffer.from("abc"))).statusCode, 204);
    assert.equal((await patchUpload(owner, id, 0, Buffer.from("EVIL"))).statusCode, 409);
    assert.equal((await patchUpload(owner, id, 3, Buffer.from("TOO-LONG"))).statusCode, 413);
    assert.equal((await bytes(owner, `/uploads/${id}`, "HEAD")).headers["upload-offset"], "3");
    const racing = await Promise.allSettled([
      patchUpload(owner, id, 3, Buffer.from("def")),
      patchUpload(owner, id, 3, Buffer.from("def")),
    ]);
    assert.ok(racing.some((r) => r.status === "fulfilled" && r.value.statusCode === 204));
    await owner.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });
    const node = (await owner.call(api.items.get, { params: { id: created.itemId } })).nodes[0];
    assert.equal((await bytes(owner, urls.nodeContent(node.id))).body, "abcdef");
    assert.equal((await bytes(owner, urls.nodeContent(node.id), "GET", { range: "bytes=0-1,3-4" })).statusCode, 416);
    assert.equal(
      (await bytes(owner, urls.nodeContent(node.id), "GET", { range: "bytes=9007199254740992-" })).statusCode,
      416,
    );
    assert.equal((await bytes(owner, urls.nodeContent(node.id), "GET", { range: "bytes=2-4" })).body, "cde");
  } finally {
    await instance.close();
  }
});

test("content audit: share expiry denies metadata, conditional and range representations before maintenance", async (t) => {
  const instance = await start();
  try {
    const owner = await member(instance, "expiry-owner");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const saved = await send(owner, [{ path: "x.txt", data: "expiry secret" }], {
      destination: { kind: "link", days: 1 },
    });
    const node = (await owner.call(api.items.get, { params: { id: saved.result.itemId } })).nodes[0];
    const visitor = new Client(instance);
    await visitor.call(api.links.open, { params: { token: saved.result.link!.token } });
    const allowed = await bytes(visitor, urls.shareContent(saved.result.link!.token, node.id));
    assert.equal(allowed.statusCode, 200);
    now += DAY_MS;
    await assert.rejects(visitor.call(api.links.open, { params: { token: saved.result.link!.token } }), rejected(404));
    for (const method of ["GET", "HEAD"] as const)
      for (const url of [
        urls.shareContent(saved.result.link!.token, node.id),
        urls.shareThumbnail(saved.result.link!.token, node.id),
        urls.shareZip(saved.result.link!.token),
      ])
        assert.equal(
          (await bytes(visitor, url, method, { range: "bytes=0-1", "if-none-match": String(allowed.headers.etag) }))
            .statusCode,
          404,
        );
    assert.equal((await bytes(owner, urls.nodeContent(node.id))).body, "expiry secret");
    assert.equal(
      instance.ctx.db.value("SELECT count(*) FROM links WHERE id = ?", saved.result.link!.id),
      1,
      "authorization does not rely on cleanup",
    );
  } finally {
    t.mock.restoreAll();
    await instance.close();
  }
});

test("content audit: completing a share rechecks member session revocation after password hashing", async () => {
  const instance = await start();
  const release = deferred();
  try {
    const owner = await member(instance, "completion-revoke");
    const created = await owner.call(api.transfers.create, {
      body: { ...manifest(owner), files: [], text: "private after signout" },
    });
    const began = deferred();
    heldHash = { started: began.resolve, release: release.promise };
    const pending = owner.call(api.transfers.complete, {
      params: { id: created.id },
      body: { destination: { kind: "link", days: 1, password: "protected" } },
    });
    const denied = assert.rejects(pending, rejected(401));
    await began.promise;
    await owner.call(api.session.signOut);
    assert.equal(
      instance.ctx.db.value(
        "SELECT count(*) FROM sessions WHERE user_id = (SELECT owner FROM transfers WHERE id = ?)",
        created.id,
      ),
      0,
    );
    release.resolve();
    await denied;
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM links WHERE item = ?", created.itemId), 0);
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", created.id), "open");
  } finally {
    release.resolve();
    heldHash = null;
    await instance.close();
  }
});

for (const revoke of [false, true]) {
  test(`content audit: network upload publication ${revoke ? "rejects a revoked session" : "accepts a live session"}`, async (t) => {
    const instance = await start();
    const release = deferred();
    try {
      const owner = await member(instance, revoke ? "upload-revoked" : "upload-live");
      const created = await owner.call(api.transfers.create, { body: manifest(owner) });
      const began = deferred();
      const actualStage = instance.ctx.blobs.stage.bind(instance.ctx.blobs);
      t.mock.method(instance.ctx.blobs, "stage", async (...args: Parameters<typeof actualStage>) => {
        began.resolve();
        await release.promise;
        return actualStage(...args);
      });
      const base = await instance.app.listen({ port: 0, host: "127.0.0.1" });
      const pending = networkPatch(base, owner, created.uploads[0].id, Buffer.from("DATA"));
      await began.promise;
      if (revoke) await owner.call(api.session.signOut);
      release.resolve();
      const response = await pending;
      assert.equal(response.status, revoke ? 401 : 204, response.body);
      assert.equal(
        instance.ctx.db.value("SELECT count(*) FROM nodes WHERE item = ? AND state = 'ready'", created.itemId),
        revoke ? 0 : 1,
      );
    } finally {
      release.resolve();
      t.mock.restoreAll();
      await instance.close();
    }
  });
}
