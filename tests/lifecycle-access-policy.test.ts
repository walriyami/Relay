import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import workerThreads from "node:worker_threads";
import sharp from "sharp";
import { api, urls } from "../shared/api.ts";
import { DAY_MS } from "../server/lib/time.ts";

// Delay one actual hash completion so revocation lands after authorization and before the write.
const originalScrypt = crypto.scrypt;
let holdHash: null | { started: () => void; release: Promise<void> } = null;
crypto.scrypt = (...args: unknown[]) => {
  const callback = args.pop() as (...result: unknown[]) => void;
  const held = holdHash;
  holdHash = null;
  held?.started();
  return (originalScrypt as (...values: unknown[]) => void)(...args, (...result: unknown[]) => {
    if (held) void held.release.then(() => callback(...result));
    else callback(...result);
  });
};
syncBuiltinESMExports();
const { admin, ApiError, Client, member, send, start } = await import("./support/harness.ts");
const rejected = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

test("final age and Trash deadlines deny owner payloads and summary excerpts before maintenance", async (t) => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const owner = await member(instance, "deadline-owner", boss);
    const { user } = await owner.call(api.session.get);
    await boss.call(api.admin.updateMember, {
      params: { id: user.id },
      body: { limits: { ...user.limits, keepDays: 3 }, expectedLimits: user.limits },
    });
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    await owner.call(api.account.update, { body: { trashDays: 1 } });
    const saved = await send(owner, [{ path: "payload.txt", data: "file payload" }], {
      text: "secret text payload",
      destination: { kind: "link", days: 7 },
    });
    const trash = await send(owner, [{ path: "trash.txt", data: "trash file payload" }], {
      text: "secret trash text payload",
    });
    await owner.call(api.items.trash, { params: { id: trash.result.itemId } });
    const savedDetail = await owner.call(api.items.get, { params: { id: saved.result.itemId } });
    const trashDetail = await owner.call(api.items.get, { params: { id: trash.result.itemId } });
    assert.equal(trashDetail.nodes.find((node) => node.kind === "text")?.text, "secret trash text payload");
    const trashFile = trashDetail.nodes.find((node) => node.kind === "file")!;
    assert.equal((await owner.raw({ method: "GET", url: urls.nodeContent(trashFile.id) })).body, "trash file payload");
    assert.equal((await owner.raw({ method: "GET", url: urls.itemZip(trashDetail.id) })).statusCode, 200);

    for (const [detail, after] of [
      [trashDetail, DAY_MS],
      [savedDetail, 2 * DAY_MS],
    ] as const) {
      now += after;
      await assert.rejects(owner.call(api.items.get, { params: { id: detail.id } }), rejected(410));
      const file = detail.nodes.find((node) => node.kind === "file")!;
      const text = detail.nodes.find((node) => node.kind === "text")!;
      for (const url of [
        urls.nodeContent(file.id),
        urls.nodeContent(text.id),
        urls.nodeThumbnail(file.id),
        urls.itemZip(detail.id),
      ]) {
        for (const method of ["GET", "HEAD"] as const)
          assert.equal((await owner.raw({ method, url })).statusCode, 410, `${method} ${url}`);
      }
      assert.equal(instance.ctx.library.summaries([detail.id]).has(detail.id), false);
      for (const view of ["library", "trash"] as const) {
        const page = await owner.call(api.items.list, { query: { view, q: "secret" } });
        assert.equal(
          page.items.some((item) => item.id === detail.id),
          false,
        );
      }
      assert.ok(instance.ctx.db.get("SELECT 1 FROM items WHERE id = ?", detail.id), "no maintenance purge was needed");
    }
    const [link] = await owner.call(api.links.list);
    assert.equal(link.item, null, "link history cannot leak expired text excerpts");
    await assert.rejects(
      new Client(instance).call(api.links.open, { params: { token: saved.result.link!.token } }),
      rejected(410),
    );
  } finally {
    t.mock.restoreAll();
    await instance.close();
  }
});

for (const operation of ["create", "update"] as const) {
  test(`password-protected share ${operation} rechecks suspension after hashing`, async () => {
    const instance = await start();
    const released = deferred();
    try {
      const boss = await admin(instance);
      const owner = await member(instance, `race-${operation}`, boss);
      const { user } = await owner.call(api.session.get);
      const saved = await send(owner, [], { text: "private content", destination: { kind: "link", days: 1 } });
      const id = operation === "create" ? crypto.randomUUID() : saved.result.link!.id;
      const began = deferred();
      holdHash = { started: began.resolve, release: released.promise };
      const pending =
        operation === "create"
          ? owner.call(api.links.create, {
              body: { id, item: saved.result.itemId, days: 3, password: "test-password" },
            })
          : owner.call(api.links.update, {
              params: { id },
              body: { password: "test-password", note: "changed while suspended" },
            });
      const denied = assert.rejects(pending, rejected(401));
      await began.promise;
      await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
      assert.equal(instance.ctx.db.value("SELECT count(*) FROM sessions WHERE user_id = ?", user.id), 0);
      released.resolve();
      await denied;
      if (operation === "create") assert.equal(instance.ctx.db.get("SELECT 1 FROM links WHERE id = ?", id), undefined);
      else {
        const row = instance.ctx.db.get<{ password_hash: string | null; note: string }>(
          "SELECT password_hash, note FROM links WHERE id = ?",
          id,
        )!;
        assert.equal(row.password_hash, null);
        assert.equal(row.note, "");
      }
    } finally {
      released.resolve();
      holdHash = null;
      await instance.close();
    }
  });
}

test("Trash setting changes preserve logically expired items' original recovery deadline", async (t) => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    await owner.call(api.account.update, { body: { trashDays: 1 } });
    const saved = await send(owner, [], { text: "already expired" });
    const id = saved.result.itemId;
    await owner.call(api.items.update, { params: { id }, body: { retentionDays: 1 } });
    const expiry = now + DAY_MS;
    now = expiry;
    await owner.call(api.account.update, { body: { trashDays: 30 } });
    const detail = await owner.call(api.items.get, { params: { id } });
    assert.equal(detail.trashed, expiry);
    assert.equal(detail.purgeAt, expiry + DAY_MS);
    now = expiry + DAY_MS;
    await assert.rejects(owner.call(api.items.restore, { params: { id } }), rejected(410));
    await assert.rejects(owner.call(api.items.get, { params: { id } }), rejected(410));
    await instance.ctx.library.sweep(now);
    assert.equal(instance.ctx.db.get("SELECT 1 FROM items WHERE id = ?", id), undefined);
  } finally {
    t.mock.restoreAll();
    await instance.close();
  }
});

test("unswept automatic expiry derives owner readability from the logical Trash deadline", async (t) => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    await owner.call(api.account.update, { body: { trashDays: 1 } });
    const saved = await send(owner, [], { text: "automatically expiring" });
    const id = saved.result.itemId;
    await owner.call(api.items.update, { params: { id }, body: { retentionDays: 1 } });
    const expiry = now + DAY_MS;
    now = expiry + DAY_MS - 1;
    assert.equal((await owner.call(api.items.get, { params: { id } })).nodes[0].text, "automatically expiring");
    assert.equal(instance.ctx.db.value("SELECT trashed FROM items WHERE id = ?", id), null);
    now++;
    await assert.rejects(owner.call(api.items.get, { params: { id } }), rejected(410));
    assert.equal(instance.ctx.library.summaries([id]).has(id), false);
    const page = await owner.call(api.items.list, { query: { view: "trash" } });
    assert.equal(page.total, 0);
    assert.equal(instance.ctx.db.value("SELECT purge_at FROM items WHERE id = ?", id), now);
  } finally {
    t.mock.restoreAll();
    await instance.close();
  }
});

for (const kind of ["file", "zip", "thumbnail-304"] as const) {
  for (const boundary of ["owner-expiry", "share-revocation", "owner-session", "share-owner-session"] as const) {
    test(`${kind} reauthorizes ${boundary} after asynchronous verification`, async (t) => {
      const instance = await start();
      const began = deferred();
      const released = deferred();
      try {
        const owner = await admin(instance);
        const recipient = new Client(instance);
        let now = Date.now();
        t.mock.method(Date, "now", () => now);
        await owner.call(api.account.update, { body: { trashDays: 1 } });
        const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
          .png()
          .toBuffer();
        const saved = await send(owner, [{ path: "photo.png", data: png, mime: "image/png" }], {
          destination: { kind: "link", days: 7 },
        });
        const node = (await owner.call(api.items.get, { params: { id: saved.result.itemId } })).nodes[0];
        const token = saved.result.link!.token;
        const shared = boundary.startsWith("share");
        if (boundary === "owner-expiry") await owner.call(api.items.trash, { params: { id: saved.result.itemId } });
        if (boundary === "share-owner-session")
          await owner.call(api.links.update, {
            params: { id: saved.result.link!.id },
            body: { password: "owner-only" },
          });
        const originalVerify = instance.ctx.blobs.verify.bind(instance.ctx.blobs);
        t.mock.method(instance.ctx.blobs, "verify", async (...args: Parameters<typeof originalVerify>) => {
          await originalVerify(...args);
          began.resolve();
          await released.promise;
        });
        const url =
          kind === "file"
            ? shared
              ? urls.shareContent(token, node.id)
              : urls.nodeContent(node.id)
            : kind === "zip"
              ? shared
                ? urls.shareZip(token)
                : urls.itemZip(saved.result.itemId)
              : shared
                ? urls.shareThumbnail(token, node.id)
                : urls.nodeThumbnail(node.id);
        const browser = boundary === "share-revocation" ? recipient : owner;
        const headers =
          kind === "thumbnail-304"
            ? { "if-none-match": `"${crypto.createHash("sha256").update(png).digest("hex")}-s"` }
            : {};
        const pending = browser.raw({ method: "GET", url, headers });
        await began.promise;
        if (boundary === "owner-expiry") now += DAY_MS;
        else if (boundary === "share-revocation")
          await owner.call(api.links.revoke, { params: { id: saved.result.link!.id } });
        else await owner.call(api.session.signOut);
        released.resolve();
        const response = await pending;
        assert.equal(
          response.statusCode,
          boundary === "owner-expiry" ? 410 : boundary === "share-revocation" ? 404 : 401,
        );
        assert.match(response.headers["content-type"] as string, /^application\/json/);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers.etag, undefined);
      } finally {
        released.resolve();
        t.mock.restoreAll();
        await instance.close();
      }
    });
  }
}

test("thumbnail rendering rechecks share access before sending the prepared image", async () => {
  const instance = await start();
  const OriginalWorker = workerThreads.Worker;
  const began = deferred();
  let release = () => {};
  class HeldWorker extends OriginalWorker {
    held = true;
    queued: [string | symbol, unknown[]][] = [];
    constructor(...args: ConstructorParameters<typeof OriginalWorker>) {
      super(...args);
      release = () => {
        this.held = false;
        for (const [event, values] of this.queued) super.emit(event, ...values);
        this.queued = [];
      };
    }
    override emit(event: string | symbol, ...values: unknown[]) {
      if (this.held && (event === "message" || event === "exit")) {
        this.queued.push([event, values]);
        if (event === "message") began.resolve();
        return true;
      }
      return super.emit(event, ...values);
    }
  }
  try {
    const owner = await admin(instance);
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
      .png()
      .toBuffer();
    const saved = await send(owner, [{ path: "photo.png", data: png, mime: "image/png" }], {
      destination: { kind: "link", days: 7 },
    });
    const node = (await owner.call(api.items.get, { params: { id: saved.result.itemId } })).nodes[0];
    workerThreads.Worker = HeldWorker;
    syncBuiltinESMExports();
    const pending = new Client(instance).raw({
      method: "GET",
      url: urls.shareThumbnail(saved.result.link!.token, node.id),
    });
    await began.promise;
    await owner.call(api.links.revoke, { params: { id: saved.result.link!.id } });
    release();
    const response = await pending;
    assert.equal(response.statusCode, 404);
    assert.match(response.headers["content-type"] as string, /^application\/json/);
  } finally {
    release();
    workerThreads.Worker = OriginalWorker;
    syncBuiltinESMExports();
    await instance.close();
  }
});
