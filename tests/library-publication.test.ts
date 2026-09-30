import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../shared/api.ts";
import { admin, patchUpload, send, start } from "./support/harness.ts";

test("saved-file publication rolls back with retention and can recover from the durable upload", async () => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const { db, library } = instance.ctx;
    const transfer = await owner.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: owner.tab,
        name: null,
        folders: [],
        files: [{ path: "atomic.txt", size: 5, mime: "text/plain" }],
      },
    });
    const node = db.value<string>("SELECT node FROM uploads WHERE id = ?", transfer.uploads[0].id)!;
    const run = db.run.bind(db);
    db.run = (sql, ...args) => {
      if (sql.startsWith("UPDATE items SET first_saved_at")) throw new Error("Injected retention write failure");
      return run(sql, ...args);
    };
    const failed = await patchUpload(owner, transfer.uploads[0].id, 0, Buffer.from("saved"));
    db.run = run;
    assert.equal(failed.statusCode, 500);
    assert.equal(db.value("SELECT state FROM nodes WHERE id = ?", node), "pending");
    assert.equal(db.value("SELECT blob FROM nodes WHERE id = ?", node), null);
    assert.equal(db.value("SELECT first_saved_at FROM items WHERE id = ?", transfer.itemId), null);
    assert.equal(db.value("SELECT offset FROM uploads WHERE id = ?", transfer.uploads[0].id), 5);
    assert.equal(db.value("SELECT completed FROM uploads WHERE id = ?", transfer.uploads[0].id), null);

    const result = await owner.call(api.transfers.complete, {
      params: { id: transfer.id },
      body: { destination: { kind: "save" } },
    });
    assert.equal(result.itemId, transfer.itemId);
    const blob = db.value<string>("SELECT blob FROM nodes WHERE id = ?", node)!;
    assert.equal(db.value("SELECT state FROM nodes WHERE id = ?", node), "ready");
    assert.ok(db.value("SELECT first_saved_at FROM items WHERE id = ?", transfer.itemId));
    assert.ok(db.value("SELECT completed FROM uploads WHERE id = ?", transfer.uploads[0].id));

    const other = (await send(owner, [], { text: "another item" })).result.itemId;
    const append = await owner.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: owner.tab,
        item: other,
        name: null,
        folders: [],
        files: [{ path: "pending.txt", size: 5, mime: "text/plain" }],
      },
    });
    const pending = db.value<string>("SELECT node FROM uploads WHERE id = ?", append.uploads[0].id)!;
    assert.throws(() => library.publishFile(transfer.itemId, pending, blob, Date.now()), /exactly one pending file/);
    assert.equal(db.value("SELECT state FROM nodes WHERE id = ?", pending), "pending");
    await owner.call(api.transfers.cancel, { params: { id: append.id } });
    assert.equal((await owner.call(api.items.get, { params: { id: other } })).texts, 1);
  } finally {
    await instance.close();
  }
});
