// Receives tus bytes into <root>/uploads/<id>.part. SHA-256 and CRC32 are carried forward as each
// chunk is written, so the last byte finishes an upload without re-reading it. Only the committed
// state (fsynced bytes whose offset is in the database) survives a failed or superseded PATCH.
import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream, statSync, renameSync, type Stats } from "node:fs";
import { open, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { LIMITS } from "../../../shared/model.ts";
import type { Context } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { fsyncDirectory, unlinkIfPresent } from "../../storage/files.ts";
import { sameBytes, sameFile } from "../../storage/blobs.ts";
import { publishItemChange } from "./publish.ts";
import { startRetention } from "../library/retention.ts";
import { assertTransferAvailability, ensureTransferAvailability } from "./availability.ts";

const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

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
  /** The part inode that `hash` describes, so a replaced or rewritten part is never published under it. */
  source: Stats | null;
  /** A failed detach may have observed different bytes, even if cancellation hid the change. */
  rebuildRequired: boolean;
  /**
   * The part's directory entry may not be durable yet. Nothing committed refers to a part until its
   * first offset commits, so that commit syncs the entry first; a file published whole never needs it.
   */
  unsyncedEntry: boolean;
  /** Resolves once the hash state matches the committed offset (rebuilt after a restart). */
  ready: Promise<void>;
  inflight: Inflight | null;
  publishing: Promise<void> | null;
  cancelled: AbortController;
};

export type Received = { offset: number } | { conflict: number };

export class Receivers {
  private readonly ctx: Context;
  private readonly receivers = new Map<string, Receiver>();
  private readonly background = new Set<Promise<unknown>>();
  private recovery = Promise.resolve();
  private readonly closing = new AbortController();
  private rebuilding = 0;
  private readonly rebuildQueue: (() => void)[] = [];
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
      receiver = {
        hash: createHash("sha256"),
        crc: 0,
        source: null,
        rebuildRequired: false,
        unsyncedEntry: false,
        ready: Promise.resolve(),
        inflight: null,
        publishing: null,
        cancelled: new AbortController(),
      };
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

  /** At most two rebuild streams, including requests arriving while startup recovery is running. */
  private async rebuild(upload: UploadRow, receiver: Receiver) {
    const signal = AbortSignal.any([this.closing.signal, receiver.cancelled.signal]);
    if (this.rebuilding >= 2) await new Promise<void>((resolve) => this.rebuildQueue.push(resolve));
    else this.rebuilding++;
    try {
      this.checkCurrent(upload.id, receiver, signal);
      const hash = createHash("sha256");
      if (upload.offset === 0) {
        // A refused first chunk can leave an uncommitted tail. There is no prefix to hash;
        // remember its current inode so the authorized writer can detach and truncate it.
        receiver.source = await stat(this.partPath(upload.id)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        this.checkCurrent(upload.id, receiver, signal);
        receiver.hash = hash;
        receiver.crc = 0;
        return;
      }
      let crc = 0;
      let read = 0;
      let before: Stats | null = null;
      try {
        // The pathname can be replaced or rewritten while it is read; compare it before and after.
        before = await stat(this.partPath(upload.id));
        for await (const chunk of createReadStream(this.partPath(upload.id), {
          start: 0,
          end: upload.offset - 1,
          signal,
        })) {
          hash.update(chunk as Buffer);
          crc = crc32(chunk as Buffer, crc);
          read += (chunk as Buffer).length;
        }
      } catch (error) {
        // An I/O/access/resource error says nothing about the durable bytes. Leave both the file
        // and committed offset intact; deleting this receiver allows the next request to retry.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.ctx.log.error({ err: error, upload: upload.id }, "upload hash rebuild unavailable; retry required");
          fail(503, "Upload storage is temporarily unavailable. Retry shortly.");
        }
      }
      if (this.receivers.get(upload.id) !== receiver) return;
      if (read === upload.offset) {
        let current: Stats | null = null;
        try {
          current = await stat(this.partPath(upload.id));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        // Bytes that changed while being read, or a part replaced since, prove nothing about loss.
        if (!before || !current || !sameBytes(before, current))
          fail(503, "Upload storage changed while it was being read. Retry shortly.");
        let source = current;
        if (upload.offset === upload.size && current.size > upload.offset) {
          // A crash may leave uncommitted trailing bytes even after every declared byte arrived.
          // A correctly sized staged hardlink is already durable and needs no mutation or copy.
          const file = await this.detach(upload, receiver, signal, current);
          try {
            this.checkCurrent(upload.id, receiver, signal);
            if ((await file.stat()).size > upload.offset) {
              await file.truncate(upload.offset);
              await file.sync();
            }
            source = await file.stat();
          } finally {
            await file.close();
          }
        }
        receiver.hash = hash;
        receiver.crc = crc;
        receiver.source = source;
        return;
      }
      // Only an absent file or a successful read ending before the committed offset proves loss.
      this.ctx.log.error({ upload: upload.id }, "upload file is missing or shorter than its offset; restarting it");
      unlinkIfPresent(this.partPath(upload.id));
      this.ctx.db.run("UPDATE uploads SET offset = 0 WHERE id = ?", upload.id);
      receiver.hash = createHash("sha256");
      receiver.crc = 0;
      receiver.source = null;
    } finally {
      const next = this.rebuildQueue.shift();
      if (next) next();
      else this.rebuilding--;
    }
  }

  /**
   * Streams one PATCH body into the upload at `offset`. A newer PATCH for the same upload destroys
   * an older one still in flight (a dead retry) and waits for it to settle before starting.
   */
  async receive(
    id: string,
    offset: number,
    body: Readable,
    destroy: () => void,
    authorize: () => void = () => {},
  ): Promise<Received> {
    const initial = uploadRow(this.ctx, id);
    if (!initial || !isActive(initial)) fail(410, "This upload is no longer accepting data.");
    ensureTransferAvailability(this.ctx, initial);
    const receiver = this.receiver(initial);
    await receiver.ready;
    if (receiver.publishing) await receiver.publishing;
    while (receiver.inflight) {
      receiver.inflight.destroy();
      await receiver.inflight.settled;
    }
    let settle!: () => void;
    const abort = new AbortController();
    const signal = AbortSignal.any([this.closing.signal, receiver.cancelled.signal, abort.signal]);
    const disconnected = () => {
      if (!body.readableEnded) abort.abort();
    };
    body.once("close", disconnected);
    if (body.destroyed) disconnected();
    const inflight: Inflight = {
      destroy: () => {
        abort.abort();
        destroy();
      },
      settled: new Promise((resolve) => (settle = resolve)),
    };
    receiver.inflight = inflight;
    try {
      let upload = uploadRow(this.ctx, id);
      // A retry that waited for its own earlier request to publish the file learns where it ended.
      if (upload?.completed != null && upload.state !== "cancelled") return { conflict: upload.size };
      if (!upload || !isActive(upload) || this.receivers.get(id) !== receiver)
        fail(410, "This upload is no longer accepting data.");
      if (receiver.rebuildRequired) {
        // Keep the same receiver and write slot until rebuilding finishes. Queued/superseding
        // PATCHes must wait for this work before they can use its newly computed hash state.
        await this.rebuild(upload, receiver);
        receiver.rebuildRequired = false;
        upload = uploadRow(this.ctx, id);
        if (!upload || !isActive(upload) || this.receivers.get(id) !== receiver)
          fail(410, "This upload is no longer accepting data.");
      }
      ensureTransferAvailability(this.ctx, upload);
      if (upload.offset !== offset) return { conflict: upload.offset };
      authorize();
      return { offset: await this.write(upload, receiver, body, signal, authorize) };
    } finally {
      body.off("close", disconnected);
      if (receiver.inflight === inflight) receiver.inflight = null;
      settle();
      const upload = uploadRow(this.ctx, id);
      if (!upload || (upload.completed === null && !isActive(upload))) unlinkIfPresent(this.partPath(id));
    }
  }

  private async write(
    upload: UploadRow,
    receiver: Receiver,
    body: Readable,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<number> {
    const hash = receiver.hash.copy();
    let crc = receiver.crc;
    let position = upload.offset;
    let source: Stats;
    const file = await this.detach(upload, receiver, signal, receiver.source).catch((error) => {
      // A superseding PATCH can interrupt copying before the identity check detects a replaced
      // or modified source. Never let the next PATCH reuse this potentially stale prefix hash.
      receiver.rebuildRequired = upload.offset > 0;
      throw error;
    });
    try {
      // Detachment verified the committed prefix, so its (possibly new) inode now carries the hash.
      receiver.source = await file.stat();
      this.checkCurrent(upload.id, receiver, signal);
      const { size } = await file.stat();
      if (size < position) throw new Error("Upload file is shorter than its committed offset.");
      if (size > position) await file.truncate(position);
      for await (const chunk of body as AsyncIterable<Buffer>) {
        this.checkCurrent(upload.id, receiver, signal);
        authorize();
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
      source = await file.stat();
      this.checkCurrent(upload.id, receiver, signal);
      authorize();
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
    ensureTransferAvailability(this.ctx, current);
    // A part published whole is linked into the content store, whose staging syncs the entry. If
    // publication fails, its committed offset outlives a lost entry only as a restart from zero.
    if (receiver.unsyncedEntry && position < upload.size) {
      await fsyncDirectory(dirname(this.partPath(upload.id)), true);
      receiver.unsyncedEntry = false;
      const latest = uploadRow(this.ctx, upload.id);
      if (!latest || !isActive(latest) || this.receivers.get(upload.id) !== receiver)
        fail(410, "This upload is no longer accepting data.");
      ensureTransferAvailability(this.ctx, latest);
    }
    // close() and the directory sync above also yield. Recheck immediately before committing
    // offsets and usage, and rebuild the old prefix if this request left an uncommitted tail.
    try {
      authorize();
    } catch (error) {
      receiver.rebuildRequired = true;
      throw error;
    }
    this.ctx.db.run(
      "UPDATE uploads SET offset = ?, touched = CASE WHEN offset < ? THEN ? ELSE touched END WHERE id = ?",
      position,
      position,
      Date.now(),
      upload.id,
    );
    receiver.hash = hash;
    receiver.crc = crc;
    receiver.source = source;
    this.count(position - upload.offset);
    // Bytes that came through someone's request link are what the owner received; the rest they sent.
    this.ctx.usage.add(upload.owner, {
      [upload.principal.startsWith("grant:") ? "received" : "uploaded"]: position - upload.offset,
    });
    if (position === upload.size) await this.publishOnce(upload.id, receiver, authorize);
    return position;
  }

  /**
   * Publishes a fully received, fsynced upload. The blob link is made durable first, off the event
   * loop; then blob row, node ready and upload complete commit in one transaction and the part file
   * is removed. Anything that cancelled or superseded the upload meanwhile wins.
   */
  private publishOnce(id: string, receiver: Receiver, authorize: () => void = () => {}): Promise<void> {
    return (receiver.publishing ??= this.publish(id, receiver, authorize).finally(() => {
      receiver.publishing = null;
    }));
  }

  private async publish(id: string, receiver: Receiver, authorize: () => void) {
    const sha256 = receiver.hash.copy().digest("hex");
    const source = receiver.source;
    // The hash describes one inode. Refuse to publish a part replaced or rewritten since: before
    // staging, as staging links it (before it can replace a hash path) and after; a fresh receiver
    // then rehashes the current bytes.
    const changed = async (file: string) => {
      const current = await stat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      return !source || !current || !sameBytes(source, current);
    };
    const refuse = (): never => {
      if (this.receivers.get(id) === receiver) this.receivers.delete(id);
      this.ctx.log.error({ upload: id }, "upload part changed after hashing; rehashing before publication");
      fail(503, "Upload storage changed before the file could be saved. Retry shortly.");
    };
    if (await changed(this.partPath(id))) refuse();
    try {
      await this.ctx.blobs.stage(this.partPath(id), sha256, source!);
    } catch (error) {
      if (await changed(this.partPath(id))) refuse();
      throw error;
    }
    if (await changed(this.partPath(id))) {
      this.ctx.blobs.unstage(sha256, this.partPath(id));
      refuse();
    }
    const upload = uploadRow(this.ctx, id);
    if (!upload || !isActive(upload) || this.receivers.get(id) !== receiver) {
      this.ctx.blobs.unstage(sha256, this.partPath(id));
      fail(410, "This upload is no longer accepting data.");
    }
    try {
      ensureTransferAvailability(this.ctx, upload);
      authorize();
      this.finalize(upload, sha256, receiver.crc);
    } catch (error) {
      this.ctx.blobs.unstage(sha256, this.partPath(id));
      ensureTransferAvailability(this.ctx, upload);
      throw error;
    }
  }

  private finalize(upload: UploadRow, sha256: string, crc: number) {
    const file = this.partPath(upload.id);
    if (statSync(file).size !== upload.size) throw new Error("Upload file size does not match its length.");
    this.ctx.db.tx(() => {
      const now = Date.now();
      assertTransferAvailability(this.ctx, upload, now);
      this.ctx.blobs.adopt(file, sha256, upload.size, crc);
      this.ctx.db.run(
        "UPDATE nodes SET state = 'ready', blob = ? WHERE id = ? AND state = 'pending'",
        sha256,
        upload.node,
      );
      this.ctx.db.run("UPDATE uploads SET offset = size, completed = ?, touched = ? WHERE id = ?", now, now, upload.id);
      startRetention(this.ctx, upload.item, now);
    });
    this.receivers.delete(upload.id);
    unlinkIfPresent(file);
    this.ctx.usage.add(upload.owner, { files: 1 });
    publishItemChange(this.ctx, upload.owner, upload.item);
  }

  /**
   * Finishes an upload whose bytes all arrived but which was not published (a crash between the two).
   * A publication already under way is waited for, so the caller sees where it ended.
   */
  async settle(id: string, authorize: () => void = () => {}) {
    await this.receivers.get(id)?.publishing?.catch(() => {});
    const upload = uploadRow(this.ctx, id);
    if (!upload || !isActive(upload)) return;
    ensureTransferAvailability(this.ctx, upload);
    if (upload.offset !== upload.size) return;
    const receiver = this.receiver(upload);
    await receiver.ready;
    while (receiver.inflight) await receiver.inflight.settled;
    const current = uploadRow(this.ctx, id);
    if (
      !this.closing.signal.aborted &&
      current &&
      isActive(current) &&
      current.offset === current.size &&
      this.receivers.get(id) === receiver
    )
      await this.publishOnce(id, receiver, authorize);
  }

  /** Forgets an upload that will receive no more bytes: stops its PATCH and removes its part file. */
  discard(id: string) {
    const receiver = this.receivers.get(id);
    receiver?.cancelled.abort();
    receiver?.inflight?.destroy();
    this.receivers.delete(id);
    try {
      unlinkIfPresent(this.partPath(id));
    } catch (error) {
      // Cancellation is already committed. Startup recovery removes orphan parts; neither cleanup
      // nor logging failure should make the caller retry a successful cancellation.
      try {
        this.ctx.log.error({ err: error, upload: id }, "Upload part removal pending; recovery will retry");
      } catch {
        // The durable cancelled/deleted upload remains the source of truth for recovery.
      }
    }
  }

  /** Partial uploads rebuild lazily on the next PATCH. Completed parts publish serially. */
  restore(upload: UploadRow) {
    if (upload.offset !== upload.size) return;
    this.recovery = this.track(
      this.recovery.then(async () => {
        if (!this.closing.signal.aborted) await this.settle(upload.id);
      }),
    );
  }

  private checkCurrent(id: string, receiver: Receiver, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.receivers.get(id) !== receiver) fail(410, "This upload is no longer accepting data.");
  }

  /** Opens a writable part without ever mutating a linked content-store inode. */
  private async detach(
    upload: UploadRow,
    receiver: Receiver,
    signal: AbortSignal,
    expected: Stats | null,
  ): Promise<FileHandle> {
    const file = this.partPath(upload.id);
    const temporary = `${file}.${randomUUID()}.detached`;
    let source: FileHandle | null = null;
    let fresh: FileHandle | null = null;
    try {
      this.checkCurrent(upload.id, receiver, signal);
      try {
        source = await open(file, "r+");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || upload.offset !== 0) throw error;
      }
      const before = await source?.stat();
      this.checkCurrent(upload.id, receiver, signal);
      // The committed prefix must come from the inode the carried hash describes. Its size and mtime
      // may differ: an interrupted write leaves or truncates uncommitted bytes past the offset.
      if (expected && (!before || !sameInode(before, expected)))
        fail(503, "Upload storage changed while preparing a write. Retry shortly.");
      // With no committed bytes, an existing part may be one whose entry was never synced.
      if (upload.offset === 0) receiver.unsyncedEntry = true;
      if (before && before.nlink <= 1) {
        const result = source!;
        source = null;
        return result;
      }
      if (before && before.size < upload.offset) throw new Error("Upload file is shorter than its committed offset.");
      fresh = await open(temporary, "wx+", 0o600);
      // Copy only the committed prefix, with bounded memory and an abort check between async I/O.
      // New uploads also use this private file, so an in-flight open cannot recreate a discarded part.
      const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, upload.offset));
      for (let position = 0; position < upload.offset;) {
        this.checkCurrent(upload.id, receiver, signal);
        const { bytesRead } = await source!.read(
          buffer,
          0,
          Math.min(buffer.length, upload.offset - position),
          position,
        );
        if (!bytesRead) throw new Error("Upload file is shorter than its committed offset.");
        for (let written = 0; written < bytesRead;) {
          this.checkCurrent(upload.id, receiver, signal);
          const { bytesWritten } = await fresh.write(buffer, written, bytesRead - written, position + written);
          written += bytesWritten;
        }
        position += bytesRead;
      }
      // A new upload's part starts empty: there is nothing to make durable until its bytes arrive.
      if (upload.offset > 0) await fresh.sync();
      this.checkCurrent(upload.id, receiver, signal);
      let current;
      try {
        current = statSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (before ? !current || !sameFile(before, current) : current)
        fail(503, "Upload storage changed while preparing a write. Retry shortly.");
      // Only this constant-size atomic publication is synchronous: discard cannot interleave
      // between the identity/abort check and rename and accidentally resurrect the part.
      renameSync(temporary, file);
      if (upload.offset > 0) await fsyncDirectory(dirname(file), true);
      const result = fresh;
      fresh = null;
      return result;
    } finally {
      try {
        await source?.close();
      } finally {
        if (fresh) {
          try {
            await fresh.close();
          } finally {
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
          }
        }
      }
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
    this.closing.abort();
    const settling: Promise<void>[] = [];
    for (const receiver of this.receivers.values())
      if (receiver.inflight) {
        receiver.inflight.destroy();
        settling.push(receiver.inflight.settled);
      }
    await Promise.all([...settling, ...this.background]);
  }
}
