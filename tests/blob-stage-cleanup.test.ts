import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { api } from "../shared/api.ts";
import { Client, member, send, start, stop, type Instance } from "./support/harness.ts";

const ioError = () => Object.assign(new Error("injected storage I/O failure"), { code: "EIO" });
const intent = (instance: Instance, sha256: string) =>
  instance.ctx.db.value<number>("SELECT count(*) FROM blob_cleanup WHERE sha256 = ?", sha256);
const recorded = (instance: Instance, sha256: string) =>
  instance.ctx.db.value<number>("SELECT count(*) FROM blobs WHERE sha256 = ?", sha256);
function source(instance: Instance, data: string) {
  const sha256 = createHash("sha256").update(data).digest("hex");
  const file = join(instance.root, "uploads", crypto.randomUUID());
  fs.writeFileSync(file, data);
  return {
    file,
    sha256,
    path: instance.ctx.blobs.path(sha256),
    size: Buffer.byteLength(data),
    crc: crc32(Buffer.from(data)),
  };
}

test("failed staging and cleanup keep intent without claiming adoption, then maintenance reclaims abandoned bytes", async () => {
  const instance = await start({}, undefined, { setup: false });
  const open = fsPromises.open;
  const unlink = fs.unlinkSync;
  try {
    const entry = source(instance, "abandoned after failed stage sync");
    fsPromises.open = async (...args: Parameters<typeof open>) => {
      if (args[0] === dirname(entry.path)) throw ioError();
      return open(...args);
    };
    fs.unlinkSync = (file) => {
      if (file === entry.path) throw ioError();
      return unlink(file);
    };
    syncBuiltinESMExports();
    await assert.rejects(instance.ctx.blobs.stage(entry.file, entry.sha256), /storage I\/O/);
    assert.equal(fs.existsSync(entry.path), true);
    assert.equal(recorded(instance, entry.sha256), 0);
    assert.equal(intent(instance, entry.sha256), 1);
    fs.unlinkSync(entry.file); // Cancellation removes the upload part, but the staged inode remains.
    fsPromises.open = open;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    instance.ctx.blobs.sweep();
    assert.equal(fs.existsSync(entry.path), false);
    assert.equal(intent(instance, entry.sha256), 0);
    assert.equal(recorded(instance, entry.sha256), 0);
  } finally {
    fsPromises.open = open;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("a failed rename and temporary unlink are retried from the durable temporary basename", async () => {
  const instance = await start({}, undefined, { setup: false });
  const rename = fsPromises.rename;
  const unlinkAsync = fsPromises.unlink;
  const unlink = fs.unlinkSync;
  let temporary = "";
  try {
    const entry = source(instance, "temporary inode after failed rename");
    fsPromises.rename = async (from, to) => {
      if (to === entry.path) {
        temporary = String(from);
        throw ioError();
      }
      return rename(from, to);
    };
    fsPromises.unlink = async (file) => {
      if (file === temporary) throw ioError();
      return unlinkAsync(file);
    };
    fs.unlinkSync = (file) => {
      if (file === temporary) throw ioError();
      return unlink(file);
    };
    syncBuiltinESMExports();
    await assert.rejects(instance.ctx.blobs.stage(entry.file, entry.sha256), /storage I\/O/);
    assert.equal(fs.existsSync(temporary), true);
    assert.equal(intent(instance, entry.sha256), 1);
    assert.equal(recorded(instance, entry.sha256), 0);
    fsPromises.rename = rename;
    fsPromises.unlink = unlinkAsync;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    fs.unlinkSync(entry.file);
    instance.ctx.blobs.sweep();
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(intent(instance, entry.sha256), 0);
  } finally {
    fsPromises.rename = rename;
    fsPromises.unlink = unlinkAsync;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

for (const failure of ["unlink", "directory sync"] as const) {
  test(`failed unstage ${failure} retains cleanup intent until maintenance succeeds`, async () => {
    const instance = await start({}, undefined, { setup: false });
    const unlink = fs.unlinkSync;
    const sync = fs.fsyncSync;
    try {
      const entry = source(instance, `unstage ${failure} retry`);
      await instance.ctx.blobs.stage(entry.file, entry.sha256);
      const directory = fs.statSync(dirname(entry.path));
      let syncs = 0;
      fs.unlinkSync = (file) => {
        if (failure === "unlink" && file === entry.path) throw ioError();
        return unlink(file);
      };
      fs.fsyncSync = (fd) => {
        const info = fs.fstatSync(fd);
        if (failure === "directory sync" && info.ino === directory.ino && info.dev === directory.dev && ++syncs === 2)
          throw ioError();
        return sync(fd);
      };
      syncBuiltinESMExports();
      assert.throws(() => instance.ctx.blobs.unstage(entry.sha256, entry.file), AggregateError);
      assert.equal(fs.existsSync(entry.path), failure === "unlink");
      assert.equal(intent(instance, entry.sha256), 1);
      assert.equal(recorded(instance, entry.sha256), 0);
      fs.unlinkSync = unlink;
      fs.fsyncSync = sync;
      syncBuiltinESMExports();
      instance.ctx.blobs.sweep();
      assert.equal(fs.existsSync(entry.path), false);
      assert.equal(intent(instance, entry.sha256), 0);
    } finally {
      fs.unlinkSync = unlink;
      fs.fsyncSync = sync;
      syncBuiltinESMExports();
      await instance.close();
    }
  });
}

test("publication rollback restores cleanup intent and retries a failed unstage", async () => {
  const instance = await start({}, undefined, { setup: false });
  const unlink = fs.unlinkSync;
  try {
    const entry = source(instance, "transaction rollback after adoption");
    await instance.ctx.blobs.stage(entry.file, entry.sha256);
    assert.throws(
      () =>
        instance.ctx.db.tx(() => {
          instance.ctx.blobs.adopt(entry.file, entry.sha256, entry.size, entry.crc);
          assert.equal(intent(instance, entry.sha256), 0);
          throw new Error("publication rollback");
        }),
      /publication rollback/,
    );
    assert.equal(intent(instance, entry.sha256), 1);
    assert.equal(recorded(instance, entry.sha256), 0);
    fs.unlinkSync = (file) => {
      if (file === entry.path) throw ioError();
      return unlink(file);
    };
    syncBuiltinESMExports();
    assert.throws(() => instance.ctx.blobs.unstage(entry.sha256, entry.file), AggregateError);
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    instance.ctx.blobs.sweep();
    assert.equal(fs.existsSync(entry.path), false);
    assert.equal(intent(instance, entry.sha256), 0);
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("another stage lease and saved deduplicated references survive a failed repair stage", async () => {
  const instance = await start();
  const open = fsPromises.open;
  try {
    const data = "shared saved and staged bytes";
    const client = await member(instance, "staging-repair-owner");
    await send(client, [{ path: "saved.txt", data }]);
    const first = source(instance, data);
    const second = source(instance, data);
    await instance.ctx.blobs.stage(first.file, first.sha256);
    fsPromises.open = async (...args: Parameters<typeof open>) => {
      if (args[0] === dirname(second.path)) throw ioError();
      return open(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(instance.ctx.blobs.stage(second.file, second.sha256), /storage I\/O/);
    assert.equal(intent(instance, first.sha256), 2);
    instance.ctx.blobs.sweep();
    assert.equal(intent(instance, first.sha256), 2);
    assert.equal(fs.readFileSync(first.path, "utf8"), data);
    fsPromises.open = open;
    syncBuiltinESMExports();
    instance.ctx.blobs.unstage(first.sha256, first.file);
    assert.equal(intent(instance, first.sha256), 0);
    assert.equal(recorded(instance, first.sha256), 1);
    assert.equal(fs.readFileSync(first.path, "utf8"), data);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM nodes WHERE blob = ?", first.sha256), 1);
  } finally {
    fsPromises.open = open;
    syncBuiltinESMExports();
    await instance.close();
  }
});

for (const failure of ["thumbnail unlink", "thumbnail directory sync"] as const) {
  test(`a referenced repair retains cleanup intent through failed ${failure} and maintenance retries`, async () => {
    const instance = await start();
    const unlinkAsync = fsPromises.unlink;
    const openAsync = fsPromises.open;
    const unlink = fs.unlinkSync;
    const open = fs.openSync;
    const close = fs.closeSync;
    const sync = fs.fsyncSync;
    const thumbnailDescriptors = new Set<number>();
    try {
      const data = "referenced payload survives rendition cleanup retries";
      const client = await member(instance, "referenced-cleanup-owner");
      await send(client, [{ path: "saved.txt", data }]);
      const entry = source(instance, data);
      const directory = join(instance.root, "thumbnails");
      const thumbnail = join(directory, `${entry.sha256}-s.webp`);
      const marker = join(directory, `${entry.sha256}-image.failed`);
      fs.writeFileSync(thumbnail, "stale thumbnail");
      fs.writeFileSync(marker, "stale decoder failure");
      fsPromises.unlink = async (file) => {
        if (failure === "thumbnail unlink" && (file === thumbnail || file === marker)) throw ioError();
        return unlinkAsync(file);
      };
      fsPromises.open = async (...args: Parameters<typeof openAsync>) => {
        if (failure === "thumbnail directory sync" && args[0] === directory) throw ioError();
        return openAsync(...args);
      };
      fs.unlinkSync = (file) => {
        if (failure === "thumbnail unlink" && (file === thumbnail || file === marker)) throw ioError();
        return unlink(file);
      };
      fs.openSync = (...args: Parameters<typeof open>) => {
        const fd = open(...args);
        if (args[0] === directory) thumbnailDescriptors.add(fd);
        return fd;
      };
      fs.closeSync = (fd) => {
        thumbnailDescriptors.delete(fd);
        return close(fd);
      };
      fs.fsyncSync = (fd) => {
        if (failure === "thumbnail directory sync" && thumbnailDescriptors.has(fd)) throw ioError();
        return sync(fd);
      };
      syncBuiltinESMExports();
      await assert.rejects(instance.ctx.blobs.stage(entry.file, entry.sha256), /storage I\/O/);
      assert.equal(intent(instance, entry.sha256), 1);
      assert.equal(recorded(instance, entry.sha256), 1);
      assert.equal(fs.readFileSync(entry.path, "utf8"), data);
      assert.equal(instance.ctx.db.value("SELECT count(*) FROM nodes WHERE blob = ?", entry.sha256), 1);
      assert.equal(fs.existsSync(thumbnail), failure === "thumbnail unlink");
      assert.equal(fs.existsSync(marker), failure === "thumbnail unlink");
      assert.throws(() => instance.ctx.blobs.sweep(), /retry required/);
      assert.equal(intent(instance, entry.sha256), 1);

      fsPromises.unlink = unlinkAsync;
      fsPromises.open = openAsync;
      fs.unlinkSync = unlink;
      fs.openSync = open;
      fs.closeSync = close;
      fs.fsyncSync = sync;
      syncBuiltinESMExports();
      instance.ctx.blobs.sweep();
      assert.equal(intent(instance, entry.sha256), 0);
      assert.equal(recorded(instance, entry.sha256), 1);
      assert.equal(fs.readFileSync(entry.path, "utf8"), data);
      assert.equal(instance.ctx.db.value("SELECT count(*) FROM nodes WHERE blob = ?", entry.sha256), 1);
      assert.equal(fs.existsSync(thumbnail), false);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      fsPromises.unlink = unlinkAsync;
      fsPromises.open = openAsync;
      fs.unlinkSync = unlink;
      fs.openSync = open;
      fs.closeSync = close;
      fs.fsyncSync = sync;
      syncBuiltinESMExports();
      await instance.close();
    }
  });
}

test("startup recovers an unadopted durable stage without treating it as a healthy blob", async () => {
  const instance = await start({}, undefined, { setup: false });
  let restarted: Instance | undefined;
  try {
    const entry = source(instance, "stop between staging and publication");
    await instance.ctx.blobs.stage(entry.file, entry.sha256);
    assert.equal(intent(instance, entry.sha256), 1);
    assert.equal(recorded(instance, entry.sha256), 0);
    await stop(instance);
    restarted = await start({}, instance.root, { setup: false });
    assert.equal(intent(restarted, entry.sha256), 0);
    assert.equal(recorded(restarted, entry.sha256), 0);
    assert.equal(fs.existsSync(entry.path), false);
  } finally {
    await restarted?.close();
    await instance.close();
  }
});

test("a stage retry resyncs ancestors even when its failed first attempt already created them", async () => {
  const instance = await start({}, undefined, { setup: false });
  const open = fsPromises.open;
  try {
    const entry = source(instance, "retry ancestor directory sync");
    let attempts = 0;
    fsPromises.open = async (...args: Parameters<typeof open>) => {
      if (args[0] === join(instance.root, "blobs") && ++attempts === 1) throw ioError();
      return open(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(instance.ctx.blobs.stage(entry.file, entry.sha256), /storage I\/O/);
    await instance.ctx.blobs.stage(entry.file, entry.sha256);
    assert.equal(attempts, 2);
    instance.ctx.blobs.adopt(entry.file, entry.sha256, entry.size, entry.crc);
    assert.equal(intent(instance, entry.sha256), 0);
    assert.equal(recorded(instance, entry.sha256), 1);
  } finally {
    fsPromises.open = open;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("staging an already linked inode syncs its directory after the remaining temporary name is removed", async () => {
  const instance = await start({}, undefined, { setup: false });
  const rename = fsPromises.rename;
  const open = fsPromises.open;
  try {
    const entry = source(instance, "same inode retry temporary cleanup");
    fs.mkdirSync(dirname(entry.path), { recursive: true });
    fs.linkSync(entry.file, entry.path);
    let temporary = "";
    let linkedAfterRename = false;
    const presentDuringSync: boolean[] = [];
    fsPromises.rename = async (from, to) => {
      await rename(from, to);
      if (to === entry.path) {
        temporary = String(from);
        linkedAfterRename = fs.existsSync(temporary);
      }
    };
    fsPromises.open = async (...args: Parameters<typeof open>) => {
      if (args[0] === dirname(entry.path)) presentDuringSync.push(fs.existsSync(temporary));
      return open(...args);
    };
    syncBuiltinESMExports();
    await instance.ctx.blobs.stage(entry.file, entry.sha256);
    assert.equal(linkedAfterRename, true);
    assert.deepEqual(presentDuringSync, [false]);
    assert.equal(fs.existsSync(temporary), false);
    instance.ctx.blobs.unstage(entry.sha256, entry.file);
  } finally {
    fsPromises.rename = rename;
    fsPromises.open = open;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("failed publication relinking keeps its temporary inode covered by the stage cleanup intent", async () => {
  const instance = await start({}, undefined, { setup: false });
  const rename = fs.renameSync;
  const unlink = fs.unlinkSync;
  let temporary = "";
  try {
    const first = source(instance, "same hash from separate source inodes");
    const second = source(instance, "same hash from separate source inodes");
    await instance.ctx.blobs.stage(first.file, first.sha256);
    await instance.ctx.blobs.stage(second.file, second.sha256);
    fs.renameSync = (from, to) => {
      if (to === first.path) {
        temporary = String(from);
        throw ioError();
      }
      return rename(from, to);
    };
    fs.unlinkSync = (file) => {
      if (file === temporary) throw ioError();
      return unlink(file);
    };
    syncBuiltinESMExports();
    assert.throws(() => instance.ctx.blobs.adopt(first.file, first.sha256, first.size, first.crc), /storage I\/O/);
    assert.equal(fs.existsSync(temporary), true);
    assert.equal(recorded(instance, first.sha256), 0);
    fs.renameSync = rename;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    instance.ctx.blobs.unstage(first.sha256, first.file);
    instance.ctx.blobs.unstage(second.sha256, second.file);
    instance.ctx.blobs.sweep();
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(fs.existsSync(first.path), false);
    assert.equal(intent(instance, first.sha256), 0);
  } finally {
    fs.renameSync = rename;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("an unstaged adoption cannot write filesystem state inside a rollbackable transaction", async () => {
  const instance = await start({}, undefined, { setup: false });
  try {
    const entry = source(instance, "must be staged before a publication transaction");
    assert.throws(
      () => instance.ctx.db.tx(() => instance.ctx.blobs.adopt(entry.file, entry.sha256, entry.size, entry.crc)),
      /must be staged/,
    );
    assert.throws(() => instance.ctx.db.tx(() => instance.ctx.blobs.adoptEmpty()), /must be staged/);
    assert.equal(fs.existsSync(entry.path), false);
    assert.equal(intent(instance, entry.sha256), 0);
    assert.equal(recorded(instance, entry.sha256), 0);
    await assert.rejects(
      instance.ctx.db.tx(() => {
        const staged = instance.ctx.blobs.stage(entry.file, entry.sha256);
        return { staged };
      }).staged,
      /outside a transaction/,
    );
    assert.equal(fs.existsSync(entry.path), false);
    assert.equal(intent(instance, entry.sha256), 0);
  } finally {
    await instance.close();
  }
});

for (const failure of ["rename", "directory sync", "record"] as const) {
  test(`a direct adoption ${failure} failure retains durable cleanup through rollback and retries`, async () => {
    const instance = await start({}, undefined, { setup: false });
    const rename = fs.renameSync;
    const unlink = fs.unlinkSync;
    const sync = fs.fsyncSync;
    const run = instance.ctx.db.run.bind(instance.ctx.db);
    let temporary = "";
    try {
      const entry = source(instance, `direct adoption ${failure}`);
      fs.renameSync = (from, to) => {
        if (to === entry.path) {
          temporary = String(from);
          assert.equal(intent(instance, entry.sha256), 1);
          assert.equal(instance.ctx.db.sqlite.isTransaction, false);
          if (failure === "rename") throw ioError();
        }
        return rename(from, to);
      };
      fs.unlinkSync = (file) => {
        if (file === entry.path || (failure === "rename" && file === temporary)) throw ioError();
        return unlink(file);
      };
      fs.fsyncSync = (fd) => {
        if (failure === "directory sync" && fs.fstatSync(fd).isDirectory()) throw ioError();
        return sync(fd);
      };
      instance.ctx.db.run = (sql, ...args) => {
        if (failure === "record" && sql.startsWith("INSERT INTO blobs(")) throw ioError();
        return run(sql, ...args);
      };
      syncBuiltinESMExports();
      assert.throws(() => instance.ctx.blobs.adopt(entry.file, entry.sha256, entry.size, entry.crc), /storage I\/O/);
      assert.equal(recorded(instance, entry.sha256), 0);
      assert.equal(intent(instance, entry.sha256), 1);
      assert.equal(fs.existsSync(failure === "rename" ? temporary : entry.path), true);
      fs.renameSync = rename;
      fs.unlinkSync = unlink;
      fs.fsyncSync = sync;
      instance.ctx.db.run = run;
      syncBuiltinESMExports();
      instance.ctx.blobs.sweep();
      assert.equal(fs.existsSync(temporary), false);
      assert.equal(fs.existsSync(entry.path), false);
      assert.equal(intent(instance, entry.sha256), 0);
    } finally {
      fs.renameSync = rename;
      fs.unlinkSync = unlink;
      fs.fsyncSync = sync;
      instance.ctx.db.run = run;
      syncBuiltinESMExports();
      await instance.close();
    }
  });
}

test("a guest zero-byte adoption failure is journaled before any publication transaction and retries", async () => {
  const instance = await start();
  const rename = fs.renameSync;
  const unlink = fs.unlinkSync;
  let temporary = "";
  try {
    const owner = await member(instance, "zero-guest-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Zero-byte guest", description: "", days: 1, maxBytes: 100 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    const emptySha = createHash("sha256").update("").digest("hex");
    const target = instance.ctx.blobs.path(emptySha);
    const id = crypto.randomUUID();
    fs.renameSync = (from, to) => {
      if (to === target) {
        temporary = String(from);
        assert.equal(intent(instance, emptySha), 1);
        assert.equal(instance.ctx.db.sqlite.isTransaction, false);
        throw ioError();
      }
      return rename(from, to);
    };
    fs.unlinkSync = (file) => {
      if (file === temporary) throw ioError();
      return unlink(file);
    };
    syncBuiltinESMExports();
    const body = {
      id,
      tab: guest.tab,
      sender: "  Dana  ",
      folders: [],
      files: [{ path: "empty.txt", size: 0, mime: "text/plain" }],
    };
    await assert.rejects(guest.call(api.requests.transfer, { params: { token: request.token }, body }));
    assert.equal(intent(instance, emptySha), 1);
    assert.equal(recorded(instance, emptySha), 0);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM items WHERE request_id = ?", request.id), 0);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM transfers WHERE id = ?", id), 0);
    assert.deepEqual(fs.readdirSync(join(instance.root, "uploads")), []);
    fs.renameSync = rename;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    instance.ctx.blobs.sweep();
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(intent(instance, emptySha), 0);
    const created = await guest.call(api.requests.transfer, { params: { token: request.token }, body });
    assert.equal(instance.ctx.db.value("SELECT sender FROM items WHERE id = ?", created.itemId), "Dana");
    assert.equal(recorded(instance, emptySha), 1);
    assert.equal(intent(instance, emptySha), 0);
  } finally {
    fs.renameSync = rename;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("a process exit immediately after direct adoption rename leaves durable cleanup for restart", async () => {
  const instance = await start({}, undefined, { setup: false });
  let restarted: Instance | undefined;
  try {
    const entry = source(instance, "direct adoption interrupted after rename");
    await stop(instance);
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { crc32 } from 'node:zlib';
      import { start } from './tests/support/harness.ts';
      const instance = await start({}, process.argv[1], { setup: false });
      const [file, hash, data] = process.argv.slice(2);
      fs.writeFileSync(file, data);
      const fd = fs.openSync(file, 'r');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        rename(from, to);
        process.exit(23);
      };
      syncBuiltinESMExports();
      instance.ctx.blobs.adopt(file, hash, Buffer.byteLength(data), crc32(Buffer.from(data)));
    `;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        instance.root,
        entry.file,
        entry.sha256,
        "direct adoption interrupted after rename",
      ],
      { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
    );
    assert.equal(child.status, 23, child.stderr);
    assert.equal(fs.existsSync(entry.path), true);
    restarted = await start({}, instance.root, { setup: false });
    assert.equal(recorded(restarted, entry.sha256), 0);
    assert.equal(intent(restarted, entry.sha256), 0);
    assert.equal(fs.existsSync(entry.path), false);
  } finally {
    await restarted?.close();
    await instance.close();
  }
});

test("a guest publication rollback preserves durable empty-blob cleanup and rolls back its sender", async () => {
  const instance = await start();
  const unlink = fs.unlinkSync;
  try {
    const owner = await member(instance, "zero-rollback-owner");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Empty rollback", description: "", days: 1, maxBytes: 100 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    const emptySha = createHash("sha256").update("").digest("hex");
    const target = instance.ctx.blobs.path(emptySha);
    instance.ctx.db.sqlite.exec(`
      CREATE TEMP TRIGGER reject_guest_transfer BEFORE INSERT ON transfers
      BEGIN SELECT RAISE(ABORT, 'injected transfer publication failure'); END;
    `);
    fs.unlinkSync = (file) => {
      if (file === target) throw ioError();
      return unlink(file);
    };
    syncBuiltinESMExports();
    const body = {
      id: crypto.randomUUID(),
      tab: guest.tab,
      sender: "Dana",
      folders: [],
      files: [{ path: "empty.txt", size: 0, mime: "text/plain" }],
    };
    await assert.rejects(guest.call(api.requests.transfer, { params: { token: request.token }, body }));
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM items WHERE request_id = ?", request.id), 0);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM transfers WHERE id = ?", body.id), 0);
    assert.equal(fs.existsSync(target), true);
    assert.equal(recorded(instance, emptySha), 1);
    assert.deepEqual(fs.readdirSync(join(instance.root, "uploads")), []);
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    instance.ctx.blobs.sweep();
    assert.equal(fs.existsSync(target), false);
    assert.equal(recorded(instance, emptySha), 0);
    instance.ctx.db.sqlite.exec("DROP TRIGGER reject_guest_transfer");
    const created = await guest.call(api.requests.transfer, { params: { token: request.token }, body });
    assert.equal(instance.ctx.db.value("SELECT sender FROM items WHERE id = ?", created.itemId), "Dana");
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});

test("empty source fsync and temporary unlink failures leave only a journaled blob temporary for maintenance", async () => {
  const instance = await start();
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  const unlink = fs.unlinkSync;
  let temporary = "";
  try {
    const client = await member(instance, "empty-source-owner");
    const emptySha = createHash("sha256").update("").digest("hex");
    const target = instance.ctx.blobs.path(emptySha);
    fs.openSync = (path, flags, mode) => {
      if (String(path).startsWith(dirname(target)) && String(path).endsWith(".tmp")) {
        temporary = String(path);
        assert.equal(intent(instance, emptySha), 1);
        assert.equal(instance.ctx.db.sqlite.isTransaction, false);
      }
      return open(path, flags, mode);
    };
    fs.fsyncSync = (fd) => {
      if (fs.fstatSync(fd).isFile()) throw ioError();
      return sync(fd);
    };
    fs.unlinkSync = (path) => {
      if (path === temporary) throw ioError();
      return unlink(path);
    };
    syncBuiltinESMExports();
    await assert.rejects(
      client.call(api.transfers.create, {
        body: {
          id: crypto.randomUUID(),
          tab: client.tab,
          name: null,
          folders: [],
          files: [{ path: "empty.txt", size: 0, mime: "text/plain" }],
        },
      }),
      { status: 500 },
    );
    assert.ok(temporary);
    assert.equal(fs.existsSync(temporary), true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(intent(instance, emptySha), 1);
    assert.equal(recorded(instance, emptySha), 0);
    assert.deepEqual(fs.readdirSync(join(instance.root, "uploads")), []);
    fs.openSync = open;
    fs.fsyncSync = sync;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    instance.ctx.blobs.sweep();
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(intent(instance, emptySha), 0);
    assert.equal(recorded(instance, emptySha), 0);
  } finally {
    fs.openSync = open;
    fs.fsyncSync = sync;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    await instance.close();
  }
});
