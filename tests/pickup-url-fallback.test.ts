import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, urls } from "../shared/api.ts";
import { getPickupCode, issueUrlPickupCode } from "../server/lib/pickup-codes.ts";
import { normalizeCode } from "../server/lib/secrets.ts";
import { admin, ApiError, Client, openShare, patchUpload, send, start, stop } from "./support/harness.ts";

test("exhausted four-digit codes preserve saved transfers, URL creation, editing, retries and id history", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-url-codes-"));
  let instance = await start({}, root);
  try {
    let owner = await admin(instance);
    await owner.call(api.admin.settings, { body: { codeLength: 4 } });
    const { result: original } = await send(owner, [{ path: "original.txt", data: "kept" }]);
    const oldLink = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: original.itemId, days: 7 },
    });
    const { db, secrets } = instance.ctx;
    const now = Date.now();
    const reserve = db.sqlite.prepare(
      "INSERT OR IGNORE INTO pickup_codes(code_hash, kind, target_id, nonce, created, retired) VALUES(?, 'share', ?, 0, ?, ?)",
    );
    db.tx(() => {
      for (let n = 0; n < 10_000; n++)
        reserve.run(secrets.pickupCodeHash(String(n).padStart(4, "0")), `reserved-${n}`, now, now);
    });
    const numericBefore = db.all("SELECT * FROM pickup_codes ORDER BY code_hash");

    const { created, result } = await send(owner, [{ path: "new.txt", data: "saved and shared" }], {
      destination: { kind: "link", days: 7 },
    });
    const link = result.link!;
    assert.equal(link.code, "");
    assert.equal((await owner.call(api.items.get, { params: { id: result.itemId } })).files, 1);
    assert.deepEqual(
      await owner.call(api.transfers.complete, {
        params: { id: created.id },
        body: { destination: { kind: "link", days: 7 } },
      }),
      result,
    );
    const visitor = new Client(instance);
    assert.equal((await openShare(visitor, link.token)).files, 1);
    const file = (await openShare(visitor, link.token)).nodes.find((n) => n.kind === "file")!;
    const download = await visitor.raw({ method: "GET", url: urls.shareContent(link.token, file.id) });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, "saved and shared");
    const editedLink = await owner.call(api.links.update, { params: { id: link.id }, body: { note: "Edited" } });
    assert.equal(editedLink.code, "");
    assert.equal(editedLink.token, link.token);
    assert.equal(editedLink.note, "Edited");

    const body = { id: crypto.randomUUID(), name: "Intake", description: "", days: 7, maxBytes: 100 };
    const request = await owner.call(api.requests.create, { body });
    assert.equal(request.code, "");
    assert.deepEqual(await owner.call(api.requests.create, { body }), request);
    const editedRequest = await owner.call(api.requests.update, {
      params: { id: request.id },
      body: { name: "Edited intake", description: "Send files", days: null, maxBytes: 100 },
    });
    assert.equal(editedRequest.code, "");
    assert.equal(editedRequest.token, request.token);
    await visitor.call(api.requests.start, { params: { token: request.token } });
    const guestTransfer = await visitor.call(api.requests.transfer, {
      params: { token: request.token },
      body: {
        id: crypto.randomUUID(),
        tab: visitor.tab,
        folders: [],
        files: [{ path: "guest.txt", size: 5, mime: "text/plain" }],
      },
    });
    assert.equal((await patchUpload(visitor, guestTransfer.uploads[0].id, 0, Buffer.from("guest"))).statusCode, 204);
    await visitor.call(api.transfers.complete, {
      params: { id: guestTransfer.id },
      body: { destination: { kind: "save" } },
    });
    assert.equal((await owner.call(api.requests.submissions, { params: { id: request.id } }))[0].files, 1);
    assert.deepEqual(
      db.all("SELECT * FROM pickup_codes WHERE code_hash LIKE 'hmac-sha256:%' ORDER BY code_hash"),
      numericBefore,
    );
    assert.deepEqual(await visitor.call(api.pickup.resolve, { body: { code: oldLink.code } }), {
      kind: "share",
      path: `/s/${oldLink.token}`,
    });

    await stop(instance);
    instance = await start({}, root);
    owner = await admin(instance);
    assert.equal((await openShare(new Client(instance), link.token)).files, 1);
    assert.equal((await owner.call(api.links.list)).find((l) => l.id === link.id)!.code, "");
    assert.equal((await owner.call(api.requests.list)).find((r) => r.id === request.id)!.code, "");
    instance.ctx.library.purge(result.itemId);
    await assert.rejects(
      owner.call(api.links.create, { body: { id: link.id, item: original.itemId, days: 7 } }),
      (e: unknown) => e instanceof ApiError && e.status === 409 && /already been used/.test(e.message),
    );
    instance.ctx.db.run("DELETE FROM requests WHERE id = ?", request.id);
    await assert.rejects(
      owner.call(api.requests.create, { body }),
      (e: unknown) => e instanceof ApiError && e.status === 409 && /already been used/.test(e.message),
    );
  } finally {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("URL code attempts are bounded at six digits and a later edit can attach an available code", async () => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const { result } = await send(owner, [{ path: "bounded.txt", data: "content" }]);
    const { db, secrets } = instance.ctx;
    const id = crypto.randomUUID();
    const now = Date.now();
    db.tx(() => {
      for (let nonce = 0; nonce < 128; nonce++) {
        const code = secrets.pickupCodeFor("share", id, nonce, 6);
        db.run(
          "INSERT INTO pickup_codes(code_hash, kind, target_id, nonce, created, retired) VALUES(?, 'request', ?, 0, ?, ?)",
          secrets.pickupCodeHash(normalizeCode(code)!),
          `collision-${nonce}`,
          now,
          now,
        );
      }
    });
    let attempts = 0;
    const generate = secrets.pickupCodeFor.bind(secrets);
    secrets.pickupCodeFor = (...args) => {
      attempts++;
      return generate(...args);
    };
    const link = await owner.call(api.links.create, { body: { id, item: result.itemId, days: 7 } });
    assert.equal(link.code, "");
    assert.equal(attempts, 128, "does not scan the remaining 999,872 candidates");
    secrets.pickupCodeFor = generate;
    // Changing the numeric mode is an existing operator action; URL-only markers stay retired.
    await owner.call(api.admin.settings, { body: { codeLength: 4 } });
    assert.equal((await owner.call(api.links.list)).find((l) => l.id === id)!.code, "");
    const edited = await owner.call(api.links.update, { params: { id }, body: { note: "Attach a code" } });
    assert.match(edited.code, /^\d{4}$/);
    assert.equal(edited.token, link.token);
    assert.deepEqual(await new Client(instance).call(api.pickup.resolve, { body: { code: edited.code } }), {
      kind: "share",
      path: `/s/${link.token}`,
    });
    assert.ok(db.value("SELECT retired FROM pickup_codes WHERE code_hash = ?", `url-only:share:${id}`));
  } finally {
    await instance.close();
  }
});

test("numeric resolution outages allow URL operations; unexpected allocator failures still roll back", async () => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const { result } = await send(owner, [{ path: "outage.txt", data: "saved" }]);
    const { db, secrets } = instance.ctx;
    db.setSetting("pickupCodeResolutionUnavailable", "1");
    const link = await owner.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Outage intake", description: "", days: 7, maxBytes: 100 },
    });
    assert.equal(link.code, "");
    assert.equal(request.code, "");
    assert.equal((await openShare(new Client(instance), link.token)).files, 1);
    assert.equal(getPickupCode(db, secrets, "share", link.id), null);
    await assert.rejects(
      new Client(instance).call(api.pickup.resolve, { body: { code: "000000" } }),
      (e: unknown) => e instanceof ApiError && e.status === 503,
    );
    db.setSetting("pickupCodeResolutionUnavailable", "0");
    const original = secrets.pickupCodeFor.bind(secrets);
    const failure = new Error("Injected allocator fault");
    const failedId = crypto.randomUUID();
    secrets.pickupCodeFor = () => {
      throw failure;
    };
    assert.throws(
      () => issueUrlPickupCode(db, secrets, "request", failedId),
      (e) => e === failure,
    );
    secrets.pickupCodeFor = original;
    assert.equal(db.value("SELECT count(*) FROM pickup_codes WHERE target_id = ?", failedId), 0);
    assert.equal((await owner.call(api.items.get, { params: { id: result.itemId } })).files, 1);
  } finally {
    await instance.close();
  }
});
