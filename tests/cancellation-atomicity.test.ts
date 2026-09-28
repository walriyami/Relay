import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { Database } from "../server/db/database.ts";
import { cancelForItem } from "../server/modules/transfers/lifecycle.ts";
import { Receivers } from "../server/modules/transfers/receivers.ts";
import { api } from "../shared/api.ts";
import { ApiError, type Client, member, patchUpload, start } from "./support/harness.ts";

function failNextCommit(db: Database) {
  const exec = db.sqlite.exec.bind(db.sqlite);
  let pending = true;
  db.sqlite.exec = (sql) => {
    if (pending && sql === "COMMIT") {
      pending = false;
      throw Object.assign(new Error("injected commit failure"), { code: "SQLITE_FULL", errcode: 13 });
    }
    exec(sql);
  };
  return () => {
    db.sqlite.exec = exec;
  };
}

const create = (client: Client, paths: string[], text?: string) =>
  client.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: client.tab,
      name: null,
      folders: [],
      files: paths.map((path) => ({ path, size: 4, mime: "" })),
      text,
    },
  });

test("post-commit actions follow outer transaction outcome and isolate failures from committed state", () => {
  const db = new Database(":memory:");
  const actions: string[] = [];
  try {
    db.tx(() => {
      db.afterCommit(() => actions.push("outer"));
      db.tx(() => db.afterCommit(() => actions.push("inner")));
      assert.deepEqual(actions, []);
    });
    assert.deepEqual(actions, ["outer", "inner"]);
    assert.throws(() =>
      db.tx(() => {
        db.tx(() => db.afterCommit(() => actions.push("rolled back")));
        throw new Error("rollback");
      }),
    );
    const restore = failNextCommit(db);
    try {
      assert.throws(() => db.tx(() => db.afterCommit(() => actions.push("failed commit"))), {
        code: "SQLITE_FULL",
      });
    } finally {
      restore();
    }
    assert.deepEqual(actions, ["outer", "inner"]);
    assert.throws(
      () =>
        db.tx(() => {
          db.setSetting("committed", "yes");
          db.afterCommit(() => {
            throw new Error("cleanup failed");
          });
          db.afterCommit(() => db.tx(() => db.setSetting("next action", "ran")));
        }),
      /Database committed, but post-commit actions failed/,
    );
    assert.equal(db.setting("committed"), "yes");
    assert.equal(db.setting("next action"), "ran");
    assert.equal(db.sqlite.isTransaction, false);
  } finally {
    db.close();
  }
});

test("failed outer trash commit preserves accepted bytes and hash state; retry removes only unfinished parts", async () => {
  const instance = await start();
  const { db } = instance.ctx;
  try {
    const client = await member(instance, "cancel-rollback");
    const transfer = await create(client, ["keep.bin", "discard.bin"]);
    const [keep, discard] = transfer.uploads;
    for (const upload of transfer.uploads)
      assert.equal((await patchUpload(client, upload.id, 0, Buffer.from("ab"))).statusCode, 204);
    const restore = failNextCommit(db);
    try {
      await assert.rejects(
        client.call(api.items.trash, { params: { id: transfer.itemId } }),
        (error) => error instanceof ApiError && error.status === 507,
      );
    } finally {
      restore();
    }
    assert.equal(db.value("SELECT trashed FROM items WHERE id = ?", transfer.itemId), null);
    assert.equal(db.value("SELECT state FROM transfers WHERE id = ?", transfer.id), "open");
    for (const upload of transfer.uploads) {
      assert.equal(db.value("SELECT offset FROM uploads WHERE id = ?", upload.id), 2);
      assert.equal(fs.readFileSync(join(instance.root, "uploads", `${upload.id}.part`), "utf8"), "ab");
    }
    assert.equal((await patchUpload(client, keep.id, 2, Buffer.from("cd"))).statusCode, 204);
    const hash = createHash("sha256").update("abcd").digest("hex");
    assert.equal(db.value("SELECT blob FROM nodes WHERE id = (SELECT node FROM uploads WHERE id = ?)", keep.id), hash);
    await client.call(api.items.trash, { params: { id: transfer.itemId } });
    assert.equal(db.value("SELECT state FROM transfers WHERE id = ?", transfer.id), "cancelled");
    assert.equal(db.value("SELECT node FROM uploads WHERE id = ?", discard.id), null);
    assert.equal(fs.existsSync(join(instance.root, "uploads", `${discard.id}.part`)), false);
    assert.equal(fs.readFileSync(instance.ctx.blobs.path(hash), "utf8"), "abcd");
  } finally {
    await instance.close();
  }
});

test("failed remove-upload commit preserves its accepted prefix until a successful retry", async () => {
  const instance = await start();
  const { db } = instance.ctx;
  try {
    const client = await member(instance, "remove-rollback");
    const transfer = await create(client, ["discard.bin"]);
    const upload = transfer.uploads[0];
    assert.equal((await patchUpload(client, upload.id, 0, Buffer.from("ab"))).statusCode, 204);
    const part = join(instance.root, "uploads", `${upload.id}.part`);
    const restore = failNextCommit(db);
    try {
      await assert.rejects(
        client.call(api.transfers.removeUpload, { params: { id: upload.id } }),
        (error) => error instanceof ApiError && error.status === 507,
      );
    } finally {
      restore();
    }
    assert.equal(fs.readFileSync(part, "utf8"), "ab");
    assert.ok(db.value("SELECT node FROM uploads WHERE id = ?", upload.id));
    await client.call(api.transfers.removeUpload, { params: { id: upload.id } });
    assert.equal(fs.existsSync(part), false);
    assert.equal(db.value("SELECT node FROM uploads WHERE id = ?", upload.id), null);
  } finally {
    await instance.close();
  }
});

test("post-commit unlink and logging failures preserve successful cancellation for orphan recovery", async (t) => {
  const instance = await start();
  const unlink = fs.unlinkSync;
  try {
    const client = await member(instance, "cancel-cleanup");
    const transfer = await create(client, ["discard.bin"], "saved text");
    const upload = transfer.uploads[0];
    assert.equal((await patchUpload(client, upload.id, 0, Buffer.from("ab"))).statusCode, 204);
    const part = join(instance.root, "uploads", `${upload.id}.part`);
    fs.unlinkSync = (file) => {
      if (String(file) === part) throw Object.assign(new Error("injected unlink failure"), { code: "EIO" });
      unlink(file);
    };
    syncBuiltinESMExports();
    const log = t.mock.method(instance.ctx.log, "error", () => {
      throw new Error("injected logging failure");
    });
    const result = await client.call(api.transfers.cancel, { params: { id: transfer.id } });
    assert.equal(result.removed, false);
    assert.equal(instance.ctx.db.value("SELECT state FROM transfers WHERE id = ?", transfer.id), "cancelled");
    assert.equal(instance.ctx.db.value("SELECT text FROM nodes WHERE item = ?", transfer.itemId), "saved text");
    assert.equal(fs.existsSync(part), true);
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    log.mock.restore();
    await instance.ctx.transfers.recover();
    assert.equal(fs.existsSync(part), false);
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("outer cancellation rollback preserves a streaming PATCH; committed cancellation stops it", async () => {
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };
  const instance = await start();
  const receivers = new Receivers(instance.ctx);
  const { db } = instance.ctx;
  try {
    const client = await member(instance, "streaming-cancel");
    for (const rollback of [true, false]) {
      const transfer = await create(client, ["stream.bin"], "saved text");
      const upload = transfer.uploads[0];
      await receivers.receive(upload.id, 0, Readable.from([Buffer.from("ab")]), () => {});
      const entered = gate();
      const release = gate();
      let destroyed = false;
      const body = Readable.from(
        (async function* () {
          yield Buffer.from("c");
          entered.resolve();
          await release.promise;
          yield Buffer.from("d");
        })(),
      );
      const receiving = receivers.receive(upload.id, 2, body, () => {
        destroyed = true;
        body.destroy();
      });
      // Attach the rejection handler before cancellation can abort the stream.
      const outcome = receiving.then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
      await entered.promise;
      const restore = rollback ? failNextCommit(db) : () => {};
      try {
        const cancel = () => db.tx(() => cancelForItem(instance.ctx, receivers, transfer.itemId));
        if (rollback) assert.throws(cancel, { code: "SQLITE_FULL" });
        else cancel();
      } finally {
        restore();
        release.resolve();
      }
      const finished = await outcome;
      assert.equal(destroyed, !rollback);
      assert.equal(db.value("SELECT state FROM transfers WHERE id = ?", transfer.id), rollback ? "open" : "cancelled");
      if (rollback) {
        assert.equal(finished.error, null);
        assert.deepEqual(finished.result, { offset: 4 });
        const hash = createHash("sha256").update("abcd").digest("hex");
        assert.equal(
          db.value("SELECT blob FROM nodes WHERE id = (SELECT node FROM uploads WHERE id = ?)", upload.id),
          hash,
        );
        assert.equal(fs.readFileSync(instance.ctx.blobs.path(hash), "utf8"), "abcd");
      } else {
        assert.ok(finished.error);
        assert.equal(db.value("SELECT offset FROM uploads WHERE id = ?", upload.id), 2);
        assert.equal(db.value("SELECT node FROM uploads WHERE id = ?", upload.id), null);
      }
      assert.equal(fs.existsSync(join(instance.root, "uploads", `${upload.id}.part`)), false);
    }
  } finally {
    await receivers.close();
    await instance.close();
  }
});
