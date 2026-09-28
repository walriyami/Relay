import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { api, headers, urls } from "../shared/api.ts";
import { NO_LIMITS } from "../shared/model.ts";
import type { TransferInput } from "../server/context.ts";
import { ApiError, admin, Client, member, patchUpload, send, start } from "./support/harness.ts";

type Files = TransferInput["files"];
const body = (client: Client, files: Partial<Files[number]>[], extra: Partial<TransferInput> = {}) => ({
  id: crypto.randomUUID(),
  tab: client.tab,
  name: null,
  folders: [],
  files: files.map((f) => ({ path: "f.bin", size: 1, mime: "", ...f })),
  ...extra,
});
const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};
const save = { destination: { kind: "save" as const } };

test("create is idempotent by id; a different manifest under the same id is refused", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const input = body(
      client,
      [
        { path: "b.txt", size: 3 },
        { path: "dir/a.txt", size: 2 },
      ],
      { text: "note" },
    );
    const first = await client.call(api.transfers.create, { body: input });
    const again = await client.call(api.transfers.create, { body: input });
    assert.deepEqual(again, first);
    assert.deepEqual(
      first.uploads.map((u) => u.path),
      ["b.txt", "dir/a.txt"],
    );
    assert.equal(await status(client.call(api.transfers.create, { body: { ...input, text: "other" } })), 409);
    const other = await member(instance, "uma");
    assert.equal(await status(other.call(api.transfers.create, { body: { ...input, tab: other.tab } })), 409);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM items"), 1);
  } finally {
    await instance.close();
  }
});

test("transfer names reject spoofing controls and malformed Unicode before creating an item", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "name-safety");
    const before = instance.ctx.db.value<number>("SELECT count(*) FROM items");
    const make = (name: string | null, path: string) =>
      client.call(api.transfers.create, {
        body: {
          id: crypto.randomUUID(),
          tab: client.tab,
          name,
          folders: [],
          files: [{ path, size: 0, mime: "" }],
        },
      });

    assert.equal(await status(make("report.\u202Etxt", "safe.txt")), 400, "item titles cannot override display order");
    assert.equal(await status(make(null, "broken\uD800.txt")), 400, "file names must contain valid Unicode");
    assert.equal(instance.ctx.db.value<number>("SELECT count(*) FROM items"), before);
  } finally {
    await instance.close();
  }
});

test("complete is idempotent: a retry returns the same link; another destination is refused", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const created = await client.call(api.transfers.create, { body: body(client, [], { text: "hello" }) });
    const destination = { kind: "link" as const, days: 3 };
    const first = await client.call(api.transfers.complete, { params: { id: created.id }, body: { destination } });
    const second = await client.call(api.transfers.complete, { params: { id: created.id }, body: { destination } });
    assert.ok(first.link);
    assert.equal(second.link?.id, first.link.id);
    assert.equal(second.link?.token, first.link.token);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM links"), 1);
    assert.equal(await status(client.call(api.transfers.complete, { params: { id: created.id }, body: save })), 409);
    const other = await member(instance, "uma");
    assert.equal(
      await status(other.call(api.transfers.complete, { params: { id: created.id }, body: { destination } })),
      404,
    );
  } finally {
    await instance.close();
  }
});

test("paths: folders are created mkdir -p style; duplicates and file/folder clashes are refused case-insensitively", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    for (const files of [
      [{ path: "a.txt" }, { path: "A.TXT" }],
      [{ path: "x" }, { path: "X/y" }],
      [{ path: "../etc" }],
      [{ path: "/abs" }],
    ])
      assert.ok([400, 409].includes(await status(client.call(api.transfers.create, { body: body(client, files) }))));
    assert.equal(
      await status(client.call(api.transfers.create, { body: body(client, [{ path: "x" }], { folders: ["X"] }) })),
      409,
    );

    const created = await client.call(api.transfers.create, {
      body: body(client, [{ path: "Photos/2024/a.jpg" }, { path: "photos/b.jpg" }, { path: "Text.txt" }], {
        folders: ["Photos/empty", "Other"],
        text: "a note",
      }),
    });
    const nodes = instance.ctx.library.nodes(created.itemId).map((n) => `${n.kind}:${n.path}`);
    assert.deepEqual(nodes.sort(), [
      "folder:Other",
      "folder:Photos",
      "folder:Photos/2024",
      "folder:Photos/empty",
      "text:Text (2).txt",
    ]);
    assert.equal(created.uploads[1].path, "Photos/b.jpg");
  } finally {
    await instance.close();
  }
});

test("admission: storage limit (including reserved bytes), capacity, disk space and guest limits", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const client = await member(instance, "tia", boss);
    const me = await client.call(api.session.get);

    await boss.call(api.admin.updateMember, {
      params: { id: me.user.id },
      body: { limits: { storage: 1000, keepDays: null, linkDays: null }, expectedLimits: NO_LIMITS },
    });
    await client.call(api.transfers.create, { body: body(client, [{ size: 600 }]) }); // reserves 600
    assert.equal(await status(client.call(api.transfers.create, { body: body(client, [{ size: 500 }]) })), 413);
    await client.call(api.transfers.create, { body: body(client, [{ size: 400 }]) });
    await boss.call(api.admin.updateMember, {
      params: { id: me.user.id },
      body: { limits: NO_LIMITS, expectedLimits: { storage: 1000, keepDays: null, linkDays: null } },
    });

    await boss.call(api.admin.settings, {
      body: { capacity: 2000, expectedCapacity: (await boss.call(api.admin.overview)).limits.capacity },
    });
    assert.equal(await status(client.call(api.transfers.create, { body: body(client, [{ size: 1500 }]) })), 507);
    await boss.call(api.admin.settings, { body: { capacity: 10 ** 15, expectedCapacity: 2000 } });

    const huge = Array.from({ length: 8 }, (_, i) => ({ path: `huge-${i}.bin`, size: 1024 ** 4 }));
    assert.equal(
      await status(client.call(api.transfers.create, { body: body(client, huge) })),
      507,
      "more than the free disk",
    );

    const input = { ...body(client, [{ size: 10 }, { size: 10, path: "g.bin" }]), folders: [] };
    const memberPrincipal = { kind: "member", userId: me.user.id } as never;
    const limited =
      (limit: { bytes: number; entries: number }, extra: { folders?: string[] } = {}) =>
      () =>
        instance.ctx.transfers.create({ ...input, ...extra }, { owner: me.user.id, principal: memberPrincipal, limit });
    assert.throws(limited({ bytes: 15, entries: 5 }), /room for 15 bytes more/);
    assert.throws(limited({ bytes: 100, entries: 1 }), /cannot take that many more files/);
    assert.throws(limited({ bytes: 100, entries: 3 }, { folders: ["one", "two"] }), /cannot take that many more/);
    assert.throws(limited({ bytes: 0, entries: 5 }), /request is full/);
  } finally {
    await instance.close();
  }
});

test("a manifest with about 20,000 long paths is accepted by the transfer route", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const prefix = Array.from({ length: 5 }, () => "p".repeat(170)).join("/");
    const files = Array.from({ length: 20_000 }, (_, i) => ({
      path: `${prefix}/${i}.txt`,
      size: 0,
      mime: "text/plain",
    }));
    const created = await client.call(api.transfers.create, {
      body: { id: crypto.randomUUID(), tab: client.tab, name: null, folders: [], files },
    });
    assert.equal(created.uploads.length, files.length);
    assert.equal(instance.ctx.library.nodes(created.itemId).length, files.length + 5, "five shared parent folders");
  } finally {
    await instance.close();
  }
});

test("create rejects an outer transaction before preparing filesystem state", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const me = await client.call(api.session.get);
    const principal = { kind: "member", userId: me.user.id } as never;
    assert.throws(
      () =>
        instance.ctx.db.tx(() => {
          instance.ctx.transfers.create(body(client, [{ path: "empty.bin", size: 0 }]), {
            owner: me.user.id,
            principal,
          });
        }),
      /outside an existing transaction/,
    );
    const emptySha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    assert.equal(existsSync(instance.ctx.blobs.path(emptySha)), false);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM blobs"), 0);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM blob_cleanup"), 0);
    assert.deepEqual(readdirSync(join(instance.root, "uploads")), []);
  } finally {
    await instance.close();
  }
});

test("cancel keeps saved files and removes the rest; an item with nothing saved is removed", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const created = await client.call(api.transfers.create, {
      body: body(client, [
        { path: "done.txt", size: 4 },
        { path: "partial.bin", size: 100 },
      ]),
    });
    assert.equal((await patchUpload(client, created.uploads[0].id, 0, Buffer.from("done"))).statusCode, 204);
    assert.equal((await patchUpload(client, created.uploads[1].id, 0, Buffer.alloc(40))).statusCode, 204);
    assert.deepEqual(await client.call(api.transfers.cancel, { params: { id: created.id } }), {
      saved: 1,
      removed: false,
    });
    const detail = await client.call(api.items.get, { params: { id: created.itemId } });
    assert.deepEqual(
      detail.nodes.map((n) => n.path),
      ["done.txt"],
    );
    assert.equal(detail.uploading, false);
    assert.equal((await patchUpload(client, created.uploads[1].id, 40, Buffer.alloc(60))).statusCode, 410);
    assert.deepEqual(readdirSync(join(instance.root, "uploads")), []);
    assert.equal(await status(client.call(api.transfers.complete, { params: { id: created.id }, body: save })), 410);

    const empty = await client.call(api.transfers.create, { body: body(client, [{ path: "x.bin", size: 10 }]) });
    await patchUpload(client, empty.uploads[0].id, 0, Buffer.alloc(5));
    assert.deepEqual(await client.call(api.transfers.cancel, { params: { id: empty.id } }), {
      saved: 0,
      removed: true,
    });
    assert.equal(await status(client.call(api.items.get, { params: { id: empty.itemId } })), 404);
    assert.equal(instance.ctx.db.value("SELECT coalesce(sum(size), 0) FROM nodes WHERE state = 'pending'"), 0);

    const finished = await send(client, [{ path: "a.txt", data: "a" }]);
    assert.equal(await status(client.call(api.transfers.cancel, { params: { id: finished.created.id } })), 409);
  } finally {
    await instance.close();
  }
});

test("removeUpload skips one unfinished file so the rest can complete", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const created = await client.call(api.transfers.create, {
      body: body(client, [
        { path: "keep.txt", size: 4 },
        { path: "skip.bin", size: 100 },
      ]),
    });
    await patchUpload(client, created.uploads[0].id, 0, Buffer.from("keep"));
    await patchUpload(client, created.uploads[1].id, 0, Buffer.alloc(10));
    assert.equal(await status(client.call(api.transfers.removeUpload, { params: { id: created.uploads[0].id } })), 409);
    const other = await member(instance, "uma");
    assert.equal(await status(other.call(api.transfers.removeUpload, { params: { id: created.uploads[1].id } })), 404);
    await client.call(api.transfers.removeUpload, { params: { id: created.uploads[1].id } });
    const head = await client.raw({
      method: "HEAD",
      url: urls.upload(created.uploads[1].id),
      headers: { "tus-resumable": "1.0.0" },
    });
    assert.equal(head.statusCode, 410);
    await client.call(api.transfers.complete, { params: { id: created.id }, body: save });
    const detail = await client.call(api.items.get, { params: { id: created.itemId } });
    assert.deepEqual(
      detail.nodes.map((n) => n.name),
      ["keep.txt"],
    );
    assert.deepEqual(readdirSync(join(instance.root, "uploads")), []);
  } finally {
    await instance.close();
  }
});

test("closing a tab abandons its transfers; late requests from it get 409", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const created = await client.call(api.transfers.create, { body: body(client, [{ path: "x.bin", size: 100 }]) });
    await patchUpload(client, created.uploads[0].id, 0, Buffer.alloc(10));
    const other = await member(instance, "uma");
    assert.equal(await status(other.call(api.transfers.closeTab, { params: { id: client.tab } })), 404);
    await client.call(api.transfers.closeTab, { params: { id: client.tab } });

    const late = await client.raw({
      method: "PATCH",
      url: urls.upload(created.uploads[0].id),
      headers: {
        "tus-resumable": "1.0.0",
        "upload-offset": "10",
        "content-type": "application/offset+octet-stream",
        [headers.tab]: client.tab,
      },
      payload: Buffer.alloc(10),
    });
    assert.equal(late.statusCode, 409);
    assert.match(late.json<{ error: string }>().error, /tab was closed/);
    assert.equal(
      instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", created.id),
      undefined,
      "item and transfer removed",
    );
    assert.equal(await status(client.call(api.items.get, { params: { id: created.itemId } })), 404);
    assert.equal(
      (await patchUpload(client, created.uploads[0].id, 10, Buffer.alloc(10))).statusCode,
      404,
      "without the tab header",
    );
    assert.equal(await status(client.call(api.transfers.create, { body: body(client, [{ size: 1 }]) })), 409);
    assert.equal(instance.ctx.transfers.renewTab(client.tab, { kind: "member", userId: "x" } as never), false);
    assert.deepEqual(readdirSync(join(instance.root, "uploads")), []);
  } finally {
    await instance.close();
  }
});

test("closing an unknown tab prevents a later transfer from claiming it", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    await client.call(api.transfers.closeTab, { params: { id: client.tab } });
    assert.equal(await status(client.call(api.transfers.create, { body: body(client, [{ path: "late.txt" }]) })), 409);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM transfers"), 0);
  } finally {
    await instance.close();
  }
});

test("an expired tab lease cancels its open transfers in the sweep; PATCHes renew the lease", async () => {
  const instance = await start({ tabLeaseMs: 300 });
  try {
    const client = await member(instance, "tia");
    const kept = await client.call(api.transfers.create, { body: body(client, [{ path: "x.bin", size: 100 }]) });
    instance.ctx.db.run("UPDATE tabs SET lease_expires = ? WHERE id = ?", Date.now() - 1, client.tab);
    const beforePatch = instance.ctx.db.value<number>("SELECT lease_expires FROM tabs WHERE id = ?", client.tab)!;
    await patchUpload(client, kept.uploads[0].id, 0, Buffer.alloc(10)); // renews
    const renewed = instance.ctx.db.value<number>("SELECT lease_expires FROM tabs WHERE id = ?", client.tab)!;
    assert.ok(renewed > beforePatch, "PATCH renews the lease");
    await instance.ctx.transfers.sweep(renewed - 1);
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", kept.id), "open");

    await instance.ctx.transfers.sweep(renewed);
    assert.equal(await status(client.call(api.items.get, { params: { id: kept.itemId } })), 404);
    assert.equal((await patchUpload(client, kept.uploads[0].id, 10, Buffer.alloc(10))).statusCode, 404);
    assert.equal(instance.ctx.transfers.activeUploads(), 0);
    assert.equal(instance.ctx.transfers.outstandingBytes(), 0);
  } finally {
    await instance.close();
  }
});

test("upload statistics report outstanding and received bytes", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const created = await client.call(api.transfers.create, { body: body(client, [{ path: "x.bin", size: 100 }]) });
    const before = Date.now() - 1;
    await patchUpload(client, created.uploads[0].id, 0, Buffer.alloc(30));
    assert.equal(instance.ctx.transfers.activeUploads(), 1);
    assert.equal(instance.ctx.transfers.outstandingBytes(), 70);
    assert.equal(instance.ctx.transfers.receivedBytesSince(before), 30);
  } finally {
    await instance.close();
  }
});

test("guest submissions: saving only, and the owner's request page hears about every change", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "tia");
    const me = await owner.call(api.session.get);
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Photos", description: "", days: 7, maxBytes: 1000 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    const heard: string[][] = [];
    const unsubscribe = instance.ctx.events.subscribe(me.user.id, (topics) => heard.push(topics));
    const flush = () => (instance.ctx.events.flush(), heard.splice(0).flat());

    const created = await guest.call(api.requests.transfer, {
      params: { token: request.token },
      body: {
        id: crypto.randomUUID(),
        tab: guest.tab,
        folders: [],
        files: [{ path: "a.jpg", size: 4, mime: "image/jpeg" }],
      },
    });
    assert.ok(flush().includes("requests"), "created");
    assert.equal((await patchUpload(guest, created.uploads[0].id, 0, Buffer.from("jpeg"))).statusCode, 204);
    assert.ok(flush().includes("requests"), "upload finished");
    assert.equal(
      await status(
        guest.call(api.transfers.complete, {
          params: { id: created.id },
          body: { destination: { kind: "link", days: 1 } },
        }),
      ),
      403,
    );
    await guest.call(api.transfers.complete, { params: { id: created.id }, body: save });
    assert.ok(flush().includes("requests"), "completed");
    assert.equal(
      await status(owner.call(api.transfers.cancel, { params: { id: created.id } })),
      404,
      "not the owner's transfer",
    );
    unsubscribe();
  } finally {
    await instance.close();
  }
});

test("guest retries preserve identity and repeated filenames remain isolated between transfers", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "tia");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Drop", description: "", days: 7, maxBytes: 1000 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    const firstBody = {
      id: crypto.randomUUID(),
      tab: guest.tab,
      folders: ["Folder"],
      files: [{ path: "file.txt", size: 0, mime: "text/plain" }],
    };
    const first = await guest.call(api.requests.transfer, { params: { token: request.token }, body: firstBody });
    const retry = await guest.call(api.requests.transfer, { params: { token: request.token }, body: firstBody });
    assert.deepEqual(retry, first, "the same transfer ID returns the original item");

    const second = await guest.call(api.requests.transfer, {
      params: { token: request.token },
      body: { ...firstBody, id: crypto.randomUUID() },
    });
    assert.equal(second.uploads[0].path, "file.txt", "the upload response keeps the submitted path");
    const third = await guest.call(api.requests.transfer, {
      params: { token: request.token },
      body: { ...firstBody, id: crypto.randomUUID() },
    });
    assert.equal(new Set([first.itemId, second.itemId, third.itemId]).size, 3);
    for (const transfer of [first, second, third])
      assert.deepEqual(
        instance.ctx.library
          .nodes(transfer.itemId)
          .map((node) => node.path)
          .sort(),
        ["Folder", "file.txt"],
        "each transfer preserves its own filenames",
      );
  } finally {
    await instance.close();
  }
});

test("guest reservations survive stale byte progress while their tab lease remains active", async () => {
  const instance = await start();
  try {
    const owner = await member(instance, "tia");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Drop", description: "", days: 7, maxBytes: 1000 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    const inputs = Array.from({ length: 3 }, () => body(guest, [{ path: "file.txt", size: 10 }]));
    const transfers = [];
    for (const input of inputs)
      transfers.push(await guest.call(api.requests.transfer, { params: { token: request.token }, body: input }));
    assert.deepEqual(
      await guest.call(api.requests.transfer, { params: { token: request.token }, body: inputs[0] }),
      transfers[0],
      "retry remains valid at the open-transfer cap",
    );
    assert.equal(
      await status(
        guest.call(api.requests.transfer, {
          params: { token: request.token },
          body: body(guest, [{ size: 10 }]),
        }),
      ),
      429,
    );
    const memberTransfer = await owner.call(api.transfers.create, { body: body(owner, [{ size: 10 }]) });
    const now = Date.now();
    const hour = 60 * 60_000;
    instance.ctx.db.run("UPDATE transfers SET created = ?", now - 2 * hour);
    instance.ctx.db.run("UPDATE uploads SET touched = ?", now - hour);
    instance.ctx.db.run("UPDATE uploads SET touched = ? WHERE transfer = ?", now, transfers[0].id);
    instance.ctx.db.run("UPDATE tabs SET lease_expires = ?", now + 3 * hour);
    await instance.ctx.transfers.sweep(now);
    const state = (id: string) => instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", id);
    assert.equal(state(transfers[0].id), "open", "recent byte progress retains the reservation");
    assert.equal(state(transfers[1].id), "open", "stale bytes do not override the renewed tab lease");
    assert.equal(state(transfers[2].id), "open", "stale empty transfers remain open while the tab is active");
    assert.equal(state(memberTransfer.id), "open", "members may pause indefinitely within their lease");
    await instance.ctx.transfers.sweep(now + hour);
    assert.equal(state(transfers[1].id), "open", "the byte inactivity age does not shorten the active lease");
    instance.ctx.db.run("UPDATE tabs SET lease_expires = ? WHERE principal LIKE 'grant:%'", now + 2 * hour);
    await instance.ctx.transfers.sweep(now + 2 * hour);
    assert.equal(state(transfers[1].id), undefined, "lease expiry cancels and removes an empty guest submission");
    assert.equal(instance.ctx.db.get("SELECT 1 FROM items WHERE id = ?", transfers[1].itemId), undefined);
    assert.equal(state(memberTransfer.id), "open");
  } finally {
    await instance.close();
  }
});
