import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdtemp, open as openFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { threadId } from "node:worker_threads";
import { api, urls } from "../shared/api.ts";
import { configFromEnv, DEFAULT_BACKUP_INTERVAL_HOURS, DEFAULT_BACKUP_KEEP } from "../server/config.ts";
import {
  blobPath,
  hashFile,
  listSnapshots,
  poolDir,
  poolFiles,
  readManifest,
  scrubSnapshot,
  snapshotDir,
  verifySnapshot,
} from "../server/modules/backup/format.ts";
import { fsyncDirectory } from "../server/storage/files.ts";
import { admin, Client, member, openShare, send, start } from "./support/harness.ts";

const run = promisify(execFile);
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const operations = (...args: string[]) =>
  run(process.execPath, ["scripts/operations.ts", ...args], { cwd: process.cwd() });

test("operator backup policy comes from bounded environment config", () => {
  const config = configFromEnv({ RELAY_BACKUP_INTERVAL_HOURS: "12", RELAY_BACKUP_KEEP: "4" });
  assert.equal(config.backupIntervalHours, 12);
  assert.equal(config.backupKeep, 4);
  assert.equal(configFromEnv({}).backupIntervalHours, DEFAULT_BACKUP_INTERVAL_HOURS);
  assert.equal(configFromEnv({}).backupKeep, DEFAULT_BACKUP_KEEP);
  assert.throws(() => configFromEnv({ RELAY_BACKUP_INTERVAL_HOURS: "0" }), /must be an integer/);
  assert.throws(() => configFromEnv({ RELAY_BACKUP_KEEP: "1.5" }), /must be an integer/);
});

async function poolState(backupDir: string) {
  const state = new Map<string, number>();
  for await (const { sha256, file } of poolFiles(poolDir(backupDir))) state.set(sha256, statSync(file).ino);
  return state;
}

test("backup, verify, restore into a new instance, and download the same bytes", async () => {
  const instance = await start();
  const restored = await mkdtemp(join(tmpdir(), "relay-restore-"));
  try {
    const owner = await member(instance, "cleo");
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const { result } = await send(
      owner,
      [
        { path: "project/big.bin", data: big },
        { path: "project/small.txt", data: "small" },
        { path: "copy.txt", data: "small" },
      ],
      { text: "a note", destination: { kind: "link", days: 7 } },
    );
    // An upload in flight and a live session must not end up in the snapshot.
    const open = await owner.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: owner.tab,
        name: null,
        folders: [],
        files: [{ path: "later.bin", size: 99, mime: "" }],
      },
    });

    const name = await instance.backups.run();
    const manifest = readManifest(instance.ctx.config.backupDir, name);
    assert.equal(manifest.blobs.length, 2, "identical content is stored once");
    const publishedManifest = join(snapshotDir(instance.ctx.config.backupDir, name), "manifest.json");
    const manifestHandle = await openFile(publishedManifest, "r");
    try {
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    await fsyncDirectory(snapshotDir(instance.ctx.config.backupDir, name), true);
    await fsyncDirectory(
      join(
        poolDir(instance.ctx.config.backupDir),
        manifest.blobs[0].sha256.slice(0, 2),
        manifest.blobs[0].sha256.slice(2, 4),
      ),
      true,
    );
    const snapshot = new DatabaseSync(join(snapshotDir(instance.ctx.config.backupDir, name), "relay.sqlite"), {
      readOnly: true,
    });
    try {
      for (const table of ["sessions", "login_codes", "guest_grants", "tabs", "transfers", "uploads"])
        assert.equal((snapshot.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
      assert.equal(
        (snapshot.prepare("SELECT COUNT(*) AS n FROM nodes WHERE state = 'pending'").get() as { n: number }).n,
        0,
      );
      assert.equal(
        (snapshot.prepare("SELECT COUNT(*) AS n FROM items WHERE id = ?").get(open.itemId) as { n: number }).n,
        0,
      );
      assert.equal((snapshot.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 2);
    } finally {
      snapshot.close();
    }

    const verified = await operations("verify", instance.ctx.config.backupDir, name);
    assert.match(verified.stdout, /verified \(2 files\)/);
    const listed = await operations("list", instance.ctx.config.backupDir);
    assert.match(listed.stdout, new RegExp(name));
    await operations("restore", instance.ctx.config.backupDir, "latest", restored);

    const copy = await start({}, restored);
    try {
      const client = new Client(copy);
      await client.signIn("cleo", "Member-password-only");
      const [item] = (await client.call(api.items.list)).items;
      assert.equal(item.id, result.itemId);
      const detail = await client.call(api.items.get, { params: { id: item.id } });
      const node = detail.nodes.find((n) => n.path === "project/big.bin")!;
      const download = await client.raw({ method: "GET", url: urls.nodeContent(node.id) });
      assert.equal(download.statusCode, 200);
      assert.equal(sha256(download.rawPayload), sha256(big));
      assert.equal(detail.nodes.find((n) => n.kind === "text")?.text, "a note");
      // Same secret: the link still opens.
      const share = await openShare(new Client(copy), result.link!.token);
      assert.equal(share.files, 3);
    } finally {
      await copy.close();
    }
  } finally {
    await instance.close();
    await rm(restored, { recursive: true, force: true });
  }
});

test("snapshot scrubbing and database hashing run in a worker thread", async () => {
  const instance = await start();
  const temporary = await mkdtemp(join(tmpdir(), "relay-backup-worker-"));
  try {
    const boss = await admin(instance);
    await send(boss, [{ path: "worker.txt", data: "worker fixture" }]);
    const name = await instance.backups.run();
    const source = join(snapshotDir(instance.ctx.config.backupDir, name), "relay.sqlite");
    const copy = join(temporary, "relay.sqlite");
    await copyFile(source, copy);

    const result = await scrubSnapshot(copy);
    assert.notEqual(result.workerThreadId, threadId, "VACUUM and database hashing ran off the test thread");
    assert.deepEqual(result.blobs, readManifest(instance.ctx.config.backupDir, name).blobs);
    assert.deepEqual(result.database, await hashFile(copy));
  } finally {
    await instance.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("restore refuses a damaged backup or a non-empty destination", async () => {
  const instance = await start();
  const target = await mkdtemp(join(tmpdir(), "relay-restore-"));
  try {
    const boss = await admin(instance);
    await send(boss, [{ path: "x.txt", data: "important" }]);
    const dir = instance.ctx.config.backupDir;
    const name = await instance.backups.run();

    await writeFile(join(target, "something"), "here");
    await assert.rejects(operations("restore", dir, name, target), /must be an empty directory/);
    await rm(join(target, "something"));

    const [blob] = readManifest(dir, name).blobs;
    await writeFile(blobPath(poolDir(dir), blob.sha256), "tampered");
    await assert.rejects(verifySnapshot(dir, name), /does not match its checksum/);
    await assert.rejects(operations("restore", dir, name, target), /does not match its checksum/);
    assert.equal(existsSync(join(target, "relay.sqlite")), false);
  } finally {
    await instance.close();
    await rm(target, { recursive: true, force: true });
  }
});

test("backups are incremental, and retention prunes snapshots and the pool", async () => {
  const instance = await start({ backupKeep: 2 });
  try {
    const boss = await admin(instance);
    const dir = instance.ctx.config.backupDir;
    instance.ctx.db.setSetting("backupKeep", "1"); // Values from the removed settings API are ignored.
    const { result: kept } = await send(boss, [{ path: "kept.txt", data: "kept content" }]);
    const { result: gone } = await send(boss, [{ path: "gone.txt", data: "content that is purged" }]);
    const goneSha = sha256("content that is purged");

    const first = await instance.backups.run();
    const before = await poolState(dir);
    assert.equal(before.size, 2);
    const second = await instance.backups.run();
    assert.deepEqual(await poolState(dir), before, "the second backup copies no blobs");
    assert.notEqual(first, second);

    await boss.call(api.items.trash, { params: { id: gone.itemId } });
    await boss.call(api.items.remove, { params: { id: gone.itemId } });
    const third = await instance.backups.run();
    assert.deepEqual(listSnapshots(dir), [second, third], "only the newest two are kept");
    assert.ok((await poolState(dir)).has(goneSha), "the kept older snapshot still needs it");
    const fourth = await instance.backups.run();
    assert.deepEqual(listSnapshots(dir), [third, fourth]);
    assert.deepEqual([...(await poolState(dir)).keys()], [sha256("kept content")], "unreferenced blobs leave the pool");
    for (const name of listSnapshots(dir)) await verifySnapshot(dir, name);
    assert.ok(kept.itemId);

    assert.deepEqual(listSnapshots(dir), [third, fourth]);
    assert.ok(Number(instance.ctx.db.setting("backupLast")) >= readManifest(dir, fourth).created);
  } finally {
    await instance.close();
  }
});

for (const damage of ["truncated", "same size"] as const) {
  test(`backup rejects a ${damage} reused blob before publication or retention`, async () => {
    const instance = await start({ backupKeep: 1 });
    try {
      const boss = await admin(instance);
      const dir = instance.ctx.config.backupDir;
      const data = Buffer.alloc(128 * 1024, 0x51);
      await send(boss, [{ path: "kept.bin", data }]);
      const first = await instance.backups.run();
      const manifest = readManifest(dir, first);
      const lastSuccess = instance.ctx.db.setting("backupLast");
      const [blob] = manifest.blobs;
      const target = blobPath(poolDir(dir), blob.sha256);
      const damaged = damage === "truncated" ? Buffer.from("bad") : Buffer.from(data);
      damaged[0] ^= 0xff;
      await writeFile(target, damaged);

      await assert.rejects(instance.backups.run(), /does not match its checksum/);
      assert.deepEqual(listSnapshots(dir), [first], "failure does not publish or prune a snapshot");
      assert.deepEqual(readManifest(dir, first), manifest, "the prior snapshot remains untouched");
      assert.equal(instance.ctx.db.setting("backupLast"), lastSuccess);
      assert.match(instance.ctx.db.setting("backupError")!, /does not match its checksum/);
      assert.deepEqual(await readdir(join(dir, "snapshots")), [first], "no partial snapshot remains");

      await copyFile(instance.ctx.blobs.path(blob.sha256), target);
      const recovered = await instance.backups.run();
      await verifySnapshot(dir, recovered);
      assert.deepEqual(listSnapshots(dir), [recovered], "retention resumes after a verified backup");
      assert.equal(instance.ctx.db.setting("backupError"), undefined);
    } finally {
      await instance.close();
    }
  });
}

test("purging content while a backup runs does not break it", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const dir = instance.ctx.config.backupDir;
    const items: string[] = [];
    for (let i = 0; i < 5; i++) {
      const data = Buffer.alloc(2 * 1024 * 1024, i + 1);
      items.push((await send(boss, [{ path: `f${i}.bin`, data }])).result.itemId);
    }
    const shas = items.map((_, i) => sha256(Buffer.alloc(2 * 1024 * 1024, i + 1)));
    for (const id of items) await boss.call(api.items.trash, { params: { id } });

    const originalPath = instance.ctx.blobs.path.bind(instance.ctx.blobs);
    let onCopy!: () => void;
    const copying = new Promise<void>((resolve) => (onCopy = resolve));
    instance.ctx.blobs.path = (sha256) => {
      const path = originalPath(sha256);
      onCopy();
      return path;
    };
    const running = instance.backups.run();
    await copying;
    for (const id of items) await boss.call(api.items.remove, { params: { id } });
    const name = await running;
    instance.ctx.blobs.path = originalPath;

    const manifest = await verifySnapshot(dir, name);
    assert.deepEqual(manifest.blobs.map((blob) => blob.sha256).sort(), [...shas].sort());
    for (const sha of shas)
      assert.equal(existsSync(instance.ctx.blobs.path(sha)), false, "releasing the backup hold lets GC finish");
  } finally {
    await instance.close();
  }
});

test("retention preserves unreadable snapshots and skips blob collection", async () => {
  const instance = await start({ backupKeep: 1 });
  try {
    const boss = await admin(instance);
    const dir = instance.ctx.config.backupDir;
    const old = await send(boss, [{ path: "old.txt", data: "possibly referenced only by damaged snapshot" }]);
    const oldSha = sha256("possibly referenced only by damaged snapshot");
    const first = await instance.backups.run();
    assert.ok(instance.ctx.db.setting("backupLast"));

    await boss.call(api.items.trash, { params: { id: old.result.itemId } });
    await boss.call(api.items.remove, { params: { id: old.result.itemId } });
    await writeFile(join(snapshotDir(dir, first), "manifest.json"), "{ damaged");

    await send(boss, [{ path: "new.txt", data: "new live backup" }]);
    const second = await instance.backups.run();
    assert.deepEqual(listSnapshots(dir), [first, second], "retention keeps the unreadable snapshot directory");
    assert.equal(existsSync(blobPath(poolDir(dir), oldSha)), true, "unknown references protect the blob pool");
    await assert.rejects(verifySnapshot(dir, first), /unreadable manifest/);
    await verifySnapshot(dir, second);

    const listed = await operations("list", dir);
    assert.match(listed.stdout, new RegExp(`${first}  unreadable manifest`));
  } finally {
    await instance.close();
  }
});

test("automatic backups follow the configured interval", async () => {
  const instance = await start({ backupIntervalHours: 24 });
  try {
    const hour = 3_600_000;
    const now = Date.now();
    instance.ctx.db.setSetting("backupIntervalHours", "1"); // The service config is authoritative.
    instance.backups.maybeRun(now);
    assert.equal(instance.backups.isRunning, false, "a new instance waits one interval");
    instance.backups.maybeRun(now + 24 * hour + 1000);
    assert.equal(instance.backups.isRunning, true);
    instance.backups.maybeRun(now + 24 * hour + 2000);
    await instance.backups.close();
    assert.equal(instance.backups.isRunning, false);
    const partials = (await readdir(join(instance.ctx.config.backupDir, "snapshots"))).filter((n) =>
      n.endsWith(".partial"),
    );
    assert.deepEqual(partials, [], "a stopped backup leaves no partial snapshot");
  } finally {
    await instance.close();
  }
});
