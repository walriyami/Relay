import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { admin, send, start } from "./support/harness.ts";

test("purge defers payload collection until the outer transaction commits and preserves shared bytes", async () => {
  const instance = await start();
  try {
    const owner = await admin(instance);
    const first = (await send(owner, [{ path: "first.txt", data: "shared bytes" }])).result.itemId;
    const second = (await send(owner, [{ path: "second.txt", data: "shared bytes" }])).result.itemId;
    const { db, library, blobs } = instance.ctx;
    const hash = db.value<string>("SELECT blob FROM nodes WHERE item = ?", first)!;
    const payload = blobs.path(hash);
    assert.throws(
      () =>
        db.tx(() => {
          library.purge(first);
          library.purge(second);
          assert.ok(existsSync(payload), "payload remains until the outer transaction commits");
          throw new Error("Injected rollback");
        }),
      /Injected rollback/,
    );
    assert.equal(db.value("SELECT count(*) FROM nodes WHERE blob = ?", hash), 2);
    assert.equal(readFileSync(payload, "utf8"), "shared bytes");
    db.tx(() => library.purge(first));
    assert.equal(db.value("SELECT count(*) FROM nodes WHERE blob = ?", hash), 1);
    assert.ok(existsSync(payload), "the other item still owns the bytes");
    db.tx(() => {
      library.purge(second);
      assert.ok(existsSync(payload));
    });
    assert.equal(db.value("SELECT count(*) FROM blobs WHERE sha256 = ?", hash), 0);
    assert.equal(existsSync(payload), false);
  } finally {
    await instance.close();
  }
});
