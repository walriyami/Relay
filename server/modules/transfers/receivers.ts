// Receives tus bytes into <root>/uploads/<id>.part. SHA-256 and CRC32 are carried forward as each
// chunk is written, so the last byte finishes an upload without re-reading it. Only the committed
// state (fsynced bytes whose offset is in the database) survives a failed or superseded PATCH.
import { createHash, type Hash } from "node:crypto";
import { createReadStream, statSync, truncateSync, copyFileSync, renameSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { LIMITS } from "../../../shared/model.ts";
import type { Context } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { unlinkIfPresent } from "../../storage/files.ts";
import { publishItemChange } from "./publish.ts";

export type UploadRow = {
  id: string;
  transfer: string;
  node: string | null;
  size: number;
  offset: number;
  completed: number | null;
  owner: string;
  item: string;
  principal: string;
  tab: string;
  state: "open" | "complete" | "cancelled";
};

export const uploadRow = (ctx: Context, id: string) =>
  ctx.db.get<UploadRow>(
    `SELECT u.id, u.transfer, u.node, u.size, u.offset, u.completed, t.owner, t.item, t.principal, t.tab, t.state
     FROM uploads u JOIN transfers t ON t.id = u.transfer WHERE u.id = ?`,
    id,
  );
/** Still expecting bytes: not finished, not skipped, and its transfer is open. */
export const isActive = (u: UploadRow) => u.completed === null && u.node !== null && u.state === "open";

type Inflight = { destroy: () => void; settled: Promise<void> };
type Receiver = {
  /** Hash and CRC of the committed bytes. */
  hash: Hash;
  crc: number;
  /** Resolves once the hash state matches the committed offset (rebuilt after a restart). */
  ready: Promise<void>;
  inflight: Inflight | null;
  publishing: Promise<void> | null;
};

export type Received = { offset: number } | { conflict: number };

export class Receivers {
  private readonly ctx: Context;
  private readonly receivers = new Map<string, Receiver>();
  private readonly background = new Set<Promise<unknown>>();
  /** Bytes committed per minute over the last hour, for the admin overview. */
  private readonly perMinute = new Map<number, number>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  partPath(id: string) {
    return join(this.ctx.config.root, "uploads", `${id}.part`);
  }

  /** Tracks work that must finish before shutdown; failures are logged, not thrown. */
  private track(work: Promise<unknown>): Promise<void> {
    const tracked: Promise<void> = work
      .then(() => {})
      .catch((error) => this.ctx.log.error({ err: error }, "upload recovery failed"))
      .finally(() => this.background.delete(tracked));
    this.background.add(tracked);
    return tracked;
  }

  private receiver(upload: UploadRow): Receiver {
    let receiver = this.receivers.get(upload.id);
    if (!receiver) {
      receiver = { hash: createHash("sha256"), crc: 0, ready: Promise.resolve(), inflight: null, publishing: null };
      this.receivers.set(upload.id, receiver);
      if (upload.offset > 0) {
        const rebuilding = receiver;
        receiver.ready = this.rebuild(upload, receiver).catch((error) => {
          if (this.receivers.get(upload.id) === rebuilding) this.receivers.delete(upload.id);
          throw error;
        });
        void this.track(receiver.ready);
      }
    }
    return receiver;
  }

  /** Re-reads the committed bytes of a part file; a file that lost them restarts from zero. */
  private async rebuild(upload: UploadRow, receiver: Receiver) {
    const hash = createHash("sha256");
    let crc = 0;
    let read = 0;
    let failed = false;
    try {
      for await (const chunk of createReadStream(this.partPath(upload.id), { start: 0, end: upload.offset - 1 })) {
        hash.update(chunk as Buffer);
        crc = crc32(chunk as Buffer, crc);
        read += (chunk as Buffer).length;
      }
    } catch (error) {
      failed = true;
      this.ctx.log.error({ err: error, upload: upload.id }, "upload hash rebuild failed; restarting it");
    }
    if (this.receivers.get(upload.id) !== receiver) return;
    if (!failed && read === upload.offset) {
      receiver.hash = hash;
      receiver.crc = crc;
      return;
    }
    this.ctx.log.error({ upload: upload.id }, "upload file is shorter than its offset; restarting it");
    unlinkIfPresent(this.partPath(upload.id));
    this.ctx.db.run("UPDATE uploads SET offset = 0 WHERE id = ?", upload.id);
  }

  /**
   * Streams one PATCH body into the upload at `offset`. A newer PATCH for the same upload destroys
   * an older one still in flight (a dead retry) and waits for it to settle before starting.
   */
  async receive(id: string, offset: number, body: Readable, destroy: () => void): Promise<Received> {
    const initial = uploadRow(this.ctx, id);
    if (!initial || !isActive(initial)) fail(410, "This upload is no longer accepting data.");
    const receiver = this.receiver(initial);
    await receiver.ready;
    while (receiver.inflight) {
      receiver.inflight.destroy();
      await receiver.inflight.settled;
    }
    let settle!: () => void;
    const inflight: Inflight = { destroy, settled: new Promise((resolve) => (settle = resolve)) };
    receiver.inflight = inflight;
    try {
      const upload = uploadRow(this.ctx, id);
      if (!upload || !isActive(upload) || this.receivers.get(id) !== receiver)
        fail(410, "This upload is no longer accepting data.");
      if (upload.offset !== offset) return { conflict: upload.offset };
      return { offset: await this.write(upload, receiver, body) };
    } finally {
      if (receiver.inflight === inflight) receiver.inflight = null;
      settle();
      const upload = uploadRow(this.ctx, id);
      if (!upload || (upload.completed === null && !isActive(upload))) unlinkIfPresent(this.partPath(id));
    }
  }

  private async write(upload: UploadRow, receiver: Receiver, body: Readable): Promise<number> {
    const hash = receiver.hash.copy();
    let crc = receiver.crc;
    let position = upload.offset;
    this.detach(upload.id);
    const file = await open(this.partPath(upload.id), constants.O_RDWR | constants.O_CREAT, 0o600);
    try {
      const { size } = await file.stat();
      if (size < position) throw new Error("Upload file is shorter than its committed offset.");
      if (size > position) await file.truncate(position);
      for await (const chunk of body as AsyncIterable<Buffer>) {
        if (position + chunk.length > upload.size) fail(413, "This request carries more bytes than the file's size.");
        if (position + chunk.length - upload.offset > LIMITS.chunkBytes)
          fail(413, "This request carries more than one chunk of data.");
        for (let written = 0; written < chunk.length;) {
          const { bytesWritten } = await file.write(chunk, written, chunk.length - written, position + written);
          written += bytesWritten;
        }
        hash.update(chunk);
        crc = crc32(chunk, crc);
        position += chunk.length;
      }
      await file.sync();
    } catch (error) {
      await file.truncate(upload.offset).catch(() => {});
      throw error;
    } finally {
      await file.close();
    }
    // Commit only if nothing cancelled or superseded this upload while the bytes were arriving.
    const current = uploadRow(this.ctx, upload.id);
    if (!current || !isActive(current) || this.receivers.get(upload.id) !== receiver)
      fail(410, "This upload is no longer accepting data.");
    this.ctx.db.run(
      "UPDATE uploads SET offset = ?, touched = CASE WHEN offset < ? THEN ? ELSE touched END WHERE id = ?",
      position,
      position,
      Date.now(),
      upload.id,
    );
    receiver.hash = hash;
    receiver.crc = crc;
    this.count(position - upload.offset);
    if (position === upload.size) await this.publishOnce(upload.id, receiver);
    return position;
  }

  /**
   * Publishes a fully received, fsynced upload. The blob link is made durable first, off the event
   * loop; then blob row, node ready and upload complete commit in one transaction and the part file
   * is removed. Anything that cancelled or superseded the upload meanwhile wins.
   */
  private publishOnce(id: string, receiver: Receiver): Promise<void> {
    return (receiver.publishing ??= this.publish(id, receiver).finally(() => {
      receiver.publishing = null;
    }));
  }

  private async publish(id: string, receiver: Receiver) {
    const sha256 = receiver.hash.copy().digest("hex");
    await this.ctx.blobs.stage(this.partPath(id), sha256);
    const upload = uploadRow(this.ctx, id);
    if (!upload || !isActive(upload) || this.receivers.get(id) !== receiver) {
      this.ctx.blobs.unstage(sha256);
      fail(410, "This upload is no longer accepting data.");
    }
    try {
      this.finalize(upload, sha256);
    } catch (error) {
      this.ctx.blobs.unstage(sha256);
      throw error;
    }
  }

  private finalize(upload: UploadRow, sha256: string) {
    const receiver = this.receivers.get(upload.id)!;
    const file = this.partPath(upload.id);
    if (statSync(file).size !== upload.size) throw new Error("Upload file size does not match its length.");
    const now = Date.now();
    this.ctx.db.tx(() => {
      this.ctx.blobs.adopt(file, sha256, upload.size, receiver.crc);
      this.ctx.db.run(
        "UPDATE nodes SET state = 'ready', blob = ? WHERE id = ? AND state = 'pending'",
        sha256,
        upload.node,
      );
      this.ctx.db.run("UPDATE uploads SET offset = size, completed = ?, touched = ? WHERE id = ?", now, now, upload.id);
    });
    this.receivers.delete(upload.id);
    unlinkIfPresent(file);
    publishItemChange(this.ctx, upload.owner, upload.item);
  }

  /** Finishes an upload whose bytes all arrived but which was not published (a crash between the two). */
  async settle(id: string) {
    const upload = uploadRow(this.ctx, id);
    if (!upload || !isActive(upload) || upload.offset !== upload.size) return;
    const receiver = this.receiver(upload);
    await receiver.ready;
    while (receiver.inflight) await receiver.inflight.settled;
    const current = uploadRow(this.ctx, id);
    if (current && isActive(current) && current.offset === current.size && this.receivers.get(id) === receiver)
      await this.publishOnce(id, receiver);
  }

  /** Forgets an upload that will receive no more bytes: stops its PATCH and removes its part file. */
  discard(id: string) {
    this.receivers.get(id)?.inflight?.destroy();
    this.receivers.delete(id);
    unlinkIfPresent(this.partPath(id));
  }

  /** After a restart: trims part files to their committed offsets and resumes their hash state. */
  restore(upload: UploadRow) {
    const file = this.partPath(upload.id);
    try {
      if (statSync(file).size > upload.offset) {
        this.detach(upload.id);
        truncateSync(file, upload.offset);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.receiver(upload);
    if (upload.offset === upload.size) void this.track(this.settle(upload.id));
  }

  /** Never mutate an inode that may already be linked into the content store. */
  private detach(id: string) {
    const file = this.partPath(id);
    try {
      if (statSync(file).nlink <= 1) return;
      const fresh = `${file}.detached`;
      try {
        copyFileSync(file, fresh);
        renameSync(fresh, file);
      } finally {
        unlinkIfPresent(fresh);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private count(bytes: number) {
    const minute = Math.floor(Date.now() / 60_000);
    this.perMinute.set(minute, (this.perMinute.get(minute) ?? 0) + bytes);
    for (const key of this.perMinute.keys()) if (key < minute - 60) this.perMinute.delete(key);
  }

  receivedSince(time: number) {
    let total = 0;
    for (const [minute, bytes] of this.perMinute) if ((minute + 1) * 60_000 > time) total += bytes;
    return total;
  }

  /** Stops in-flight PATCHes and waits for background recovery, before the database closes. */
  async close() {
    const settling: Promise<void>[] = [];
    for (const receiver of this.receivers.values())
      if (receiver.inflight) {
        receiver.inflight.destroy();
        settling.push(receiver.inflight.settled);
      }
    await Promise.all([...settling, ...this.background]);
  }
}
