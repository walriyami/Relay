// Verified backups: a scrubbed SQLite snapshot plus an incremental, content-addressed blob pool.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backup } from "node:sqlite";
import type { Context } from "../../context.ts";
import { HttpError } from "../../lib/errors.ts";
import { fsyncDirectory } from "../../storage/files.ts";
import {
  blobPath,
  DATABASE_FILE,
  hashFile,
  listSnapshots,
  MANIFEST_FILE,
  MANIFEST_VERSION,
  PARTIAL,
  poolDir,
  poolFiles,
  readManifest,
  scrubSnapshot,
  snapshotDir,
  snapshotsDir,
  type BlobEntry,
  type Manifest,
} from "./format.ts";

const HOUR_MS = 3_600_000;

export class Backups {
  private readonly ctx: Context;
  private running: Promise<string> | null = null;
  private abort: AbortController | null = null;
  private lastAttempt = 0;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  private get dir() {
    return this.ctx.config.backupDir;
  }

  get isRunning() {
    return !!this.running;
  }

  /**
   * Starts a backup when the last success is older than the interval. A new instance counts from
   * its creation, and a failure is retried at most hourly.
   */
  maybeRun(now: number) {
    if (this.running) return;
    const intervalMs = this.ctx.config.backupIntervalHours * HOUR_MS;
    const since = Number(
      this.ctx.db.setting("backupLast") ?? this.ctx.db.value<number>("SELECT MIN(created) FROM users") ?? now,
    );
    if (now - since < intervalMs || now - this.lastAttempt < Math.min(intervalMs, HOUR_MS)) return;
    this.run().catch(() => {});
  }

  /** Creates a snapshot and returns its name. Rejects with 409 while another one runs. */
  run(): Promise<string> {
    if (this.running) return Promise.reject(new HttpError(409, "A backup is already running."));
    this.lastAttempt = Date.now();
    const abort = new AbortController();
    this.abort = abort;
    this.running = this.create(abort.signal)
      .then(
        (name) => {
          this.ctx.db.setSetting("backupLast", String(readManifest(this.dir, name).created));
          this.ctx.db.run("DELETE FROM settings WHERE key = 'backupError'");
          return name;
        },
        (error: Error) => {
          if (!abort.signal.aborted) {
            this.ctx.db.setSetting("backupError", error.message);
            this.ctx.log.error({ err: error }, "backup failed");
          }
          throw error;
        },
      )
      .finally(() => {
        this.running = null;
        this.abort = null;
      });
    return this.running;
  }

  /** Stops a running backup (its partial snapshot is removed) and waits for it. */
  async close() {
    this.abort?.abort();
    await this.running?.catch(() => {});
  }

  private async create(signal: AbortSignal): Promise<string> {
    await this.removeLeftovers();
    const created = Date.now();
    const name = `relay-${new Date(created).toISOString().replace(/[:.]/g, "-")}`;
    const work = snapshotDir(this.dir, name + PARTIAL);
    await mkdir(work, { recursive: true });
    try {
      const database = join(work, DATABASE_FILE);
      const release = this.ctx.blobs.hold();
      let copied = 0;
      let blobs: BlobEntry[];
      let databaseDigest: BlobEntry;
      try {
        await backup(this.ctx.db.sqlite, database);
        const prepared = await scrubSnapshot(database, signal);
        blobs = prepared.blobs;
        databaseDigest = prepared.database;
        for (const blob of blobs) {
          signal.throwIfAborted();
          if (await this.addToPool(blob, signal)) copied++;
        }
      } finally {
        release();
      }
      const manifest: Manifest = {
        version: MANIFEST_VERSION,
        name,
        created,
        database: databaseDigest,
        blobs,
      };
      const manifestFile = await open(join(work, MANIFEST_FILE), "wx");
      try {
        await manifestFile.writeFile(JSON.stringify(manifest));
        await manifestFile.sync();
      } finally {
        await manifestFile.close();
      }
      await fsyncDirectory(work, true);
      await fsyncDirectory(snapshotsDir(this.dir), true);
      const complete = snapshotDir(this.dir, name);
      await rename(work, complete);
      await fsyncDirectory(complete, true);
      await fsyncDirectory(snapshotsDir(this.dir), true);
      this.ctx.log.info({ snapshot: name, blobs: blobs.length, copied }, "backup created");
    } catch (error) {
      await rm(work, { recursive: true, force: true });
      throw error;
    }
    await this.retain();
    return name;
  }

  /** Verifies reused pool blobs, or copies and verifies new ones. True if copied. */
  private async addToPool(blob: BlobEntry, signal: AbortSignal): Promise<boolean> {
    const target = blobPath(poolDir(this.dir), blob.sha256);
    const verifyExisting = async () => {
      const actual = await hashFile(target, signal);
      if (actual.sha256 !== blob.sha256 || actual.size !== blob.size)
        throw new Error(`Stored file ${blob.sha256} does not match its checksum.`);
    };
    try {
      await verifyExisting();
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temp = join(poolDir(this.dir), "tmp", randomUUID());
    await mkdir(dirname(temp), { recursive: true });
    const hash = createHash("sha256");
    let size = 0;
    const out = await open(temp, "wx");
    try {
      for await (const chunk of createReadStream(this.ctx.blobs.path(blob.sha256), {
        signal,
      }) as AsyncIterable<Buffer>) {
        hash.update(chunk);
        size += chunk.length;
        await out.writeFile(chunk);
      }
      await out.sync();
      if (hash.digest("hex") !== blob.sha256 || size !== blob.size)
        throw new Error(`Stored file ${blob.sha256} does not match its checksum.`);
    } catch (error) {
      await out.close();
      await rm(temp, { force: true });
      throw error;
    }
    await out.close();
    const targetDirectory = dirname(target);
    await mkdir(targetDirectory, { recursive: true });
    try {
      await link(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await rm(temp, { force: true });
        throw error;
      }
      await rm(temp, { force: true });
      await fsyncDirectory(dirname(temp), true);
      await verifyExisting();
      return false;
    }
    const published = await open(target, "r+");
    try {
      await published.sync();
    } finally {
      await published.close();
    }
    for (const directory of [targetDirectory, dirname(targetDirectory), poolDir(this.dir), this.dir])
      await fsyncDirectory(directory, true);
    await unlink(temp);
    await fsyncDirectory(dirname(temp), true);
    return true;
  }

  /** Partial snapshots and pool temp files left by an interrupted run. */
  private async removeLeftovers() {
    await mkdir(snapshotsDir(this.dir), { recursive: true });
    for (const entry of await readdir(snapshotsDir(this.dir)))
      if (entry.endsWith(PARTIAL)) await rm(join(snapshotsDir(this.dir), entry), { recursive: true, force: true });
    await rm(join(poolDir(this.dir), "tmp"), { recursive: true, force: true });
  }

  /** Keeps the newest configured number of snapshots, then drops unreferenced pool blobs. */
  private async retain() {
    const names = listSnapshots(this.dir);
    const keep = this.ctx.config.backupKeep;
    const readable: string[] = [];
    const unreadable = new Set<string>();
    for (const name of names) {
      try {
        readManifest(this.dir, name);
        readable.push(name);
      } catch {
        unreadable.add(name);
      }
    }
    if (unreadable.size)
      this.ctx.log.warn(
        { snapshots: [...unreadable] },
        "backup retention found unreadable manifests and will preserve their blob pool",
      );
    for (const name of readable.slice(0, Math.max(0, readable.length - keep)))
      await rm(snapshotDir(this.dir, name), { recursive: true, force: true });
    const referenced = new Set<string>();
    for (const name of listSnapshots(this.dir)) {
      try {
        for (const blob of readManifest(this.dir, name).blobs) referenced.add(blob.sha256);
      } catch {
        unreadable.add(name);
      }
    }
    if (unreadable.size) {
      this.ctx.log.warn(
        { snapshots: [...unreadable] },
        "backup retention skipped blob pool collection because snapshot references are unknown",
      );
      return;
    }
    for await (const { sha256, file } of poolFiles(poolDir(this.dir)))
      if (!referenced.has(sha256)) await rm(file, { force: true });
  }
}
