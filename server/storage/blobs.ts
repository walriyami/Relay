import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, statSync, type Stats } from "node:fs";
import { link, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore, Context, ScrubOptions, ScrubResult } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { eachFile, fsyncDirectory, unlinkIfPresent } from "./files.ts";

const SHA = /^[0-9a-f]{64}$/;
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Renditions share source bytes; a decoder's rejection only applies to that decoder. */
const THUMBNAIL_FILE = /^([0-9a-f]{64})(-[sl]\.webp|-(image|heif)\.failed)$/;
export type ThumbnailSize = "s" | "l";
export type ThumbnailDecoder = "image" | "heif";
export const thumbnailPath = (root: string, sha256: string, size: ThumbnailSize) =>
  join(root, "thumbnails", `${sha256}-${size}.webp`);
export const thumbnailFailure = (root: string, sha256: string, decoder: ThumbnailDecoder) =>
  join(root, "thumbnails", `${sha256}-${decoder}.failed`);

/** A repair replaces the inode. Detect modifications as well as replacements during an async read. */
export const sameFile = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
/** The same inode, unwritten since; linking and unlinking still change its link count and ctime. */
export const sameBytes = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

type Integrity = "ok" | "missing" | "corrupt" | "unreadable";
type BlobRow = { sha256: string; size: number; created: number; integrity: Integrity; checked_at: number | null };
type ScanProgress = { after: string; started: number; errors: number };
const PROGRESS = "blob_scrub_progress";
const FULL_CHECK = "blob_scrub_last_full_check";

export function createBlobStore(ctx: Context): BlobStore {
  const root = join(ctx.config.root, "blobs");
  const thumbnails = join(ctx.config.root, "thumbnails");
  const closing = new AbortController();
  let running: Promise<ScrubResult> | null = null;
  let current: ScrubResult | null = null;
  let lastResult: ScrubResult | null = null;
  let lastError = false;
  let examining: { sha256: string; changed: boolean } | null = null;
  let sweepAfter = "";
  type Stage = { file: string; complete: boolean; name: string; temporary: string | null };
  const staged = new Map<string, Set<Stage>>();
  const rendering = new Map<string, Set<string>>();
  /**
   * Hash directories ("ab" and "ab/cd") whose entries in their parents this process has made durable.
   * Nothing removes a hash directory, so each needs its parent synced once, not once per file in it.
   */
  const durableDirectories = new Set<string>();
  const staging = (sha256: string) => staged.has(sha256);
  const leased = (sha256: string) => staging(sha256) || rendering.has(sha256);
  const release = (sha256: string, stage: Stage) => {
    const entries = staged.get(sha256);
    entries?.delete(stage);
    if (!entries?.size) staged.delete(sha256);
  };
  const releaseFile = (sha256: string, file?: string) => {
    const stage = [...(staged.get(sha256) ?? [])].find((s) => s.complete && (file === undefined || s.file === file));
    if (stage) release(sha256, stage);
    return stage;
  };

  const path = (sha256: string) => join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  const recorded = (sha256: string) => !!ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256);
  const changing = (sha256: string) => {
    if (examining?.sha256 === sha256) examining.changed = true;
  };
  const renditionFiles = (sha256: string) => [
    thumbnailPath(ctx.config.root, sha256, "s"),
    thumbnailPath(ctx.config.root, sha256, "l"),
    thumbnailFailure(ctx.config.root, sha256, "image"),
    thumbnailFailure(ctx.config.root, sha256, "heif"),
  ];
  const invalidateThumbnails = (sha256: string) => {
    let removed = 0;
    for (const file of renditionFiles(sha256)) if (unlinkIfPresent(file)) removed++;
    fsyncDirectory(thumbnails);
    return removed;
  };
  const invalidateThumbnailsAsync = async (sha256: string) => {
    const removed = await Promise.all(
      renditionFiles(sha256).map((file) =>
        unlink(file).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return false;
          },
        ),
      ),
    );
    if (removed.some(Boolean)) await fsyncDirectory(thumbnails, true);
  };
  const removeFiles = (sha256: string) => {
    changing(sha256);
    const removed = unlinkIfPresent(path(sha256)) ? 1 : 0;
    // Sync even after ENOENT: an earlier attempt may have unlinked successfully but failed to sync.
    try {
      fsyncDirectory(dirname(path(sha256)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return removed + invalidateThumbnails(sha256);
  };
  const collect = (candidates: Iterable<string>) => {
    const errors: unknown[] = [];
    let removedFiles = 0;
    for (const sha256 of new Set(candidates)) {
      try {
        if (leased(sha256)) continue;
        const referenced = !!ctx.db.get("SELECT 1 FROM nodes WHERE blob = ? LIMIT 1", sha256);
        const pending = ctx.db.all<{ temporary: string; kind: "blob" | "thumbnail" }>(
          "SELECT temporary, kind FROM blob_cleanup WHERE sha256 = ?",
          sha256,
        );
        if (referenced && !pending.length) continue;
        // Explicit collection also covers an adoption whose surrounding transaction rolled back.
        // Persist intent before unlinking, even when no adopted blob row survived that rollback.
        if (!recorded(sha256) && !pending.length) ctx.db.run("INSERT INTO blob_cleanup(sha256) VALUES(?)", sha256);
        const directory = dirname(path(sha256));
        for (const { temporary, kind } of pending)
          if (temporary && unlinkIfPresent(join(kind === "thumbnail" ? thumbnails : directory, temporary)))
            removedFiles++;
        // A failed stage can leave newly-created ancestors that still require a sync on retry.
        if (pending.length) {
          for (const dir of [root, dirname(directory), directory]) {
            try {
              fsyncDirectory(dir);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        }
        // No await can interleave this block with adoption or node writes. Retain both kinds of
        // cleanup intent until all filesystem steps have succeeded, including retries after ENOENT.
        // A failed repair may have replaced a referenced payload before rendition invalidation
        // failed. Preserve its bytes, but retry every thumbnail unlink and its directory sync.
        removedFiles += referenced ? invalidateThumbnails(sha256) : removeFiles(sha256);
        ctx.db.tx(() => {
          if (!referenced) ctx.db.run("DELETE FROM blobs WHERE sha256 = ?", sha256);
          ctx.db.run("DELETE FROM blob_cleanup WHERE sha256 = ?", sha256);
        });
      } catch (error) {
        ctx.log.error({ err: error, blob: sha256 }, "blob cleanup failed; retry required");
        errors.push(error);
      }
    }
    return { removedFiles, errors };
  };
  const unavailable = () => fail(503, "A stored file is unavailable. Contact the administrator.");
  const mark = (row: BlobRow, integrity: Integrity) =>
    ctx.db.run(
      "UPDATE blobs SET integrity = ?, checked_at = ? WHERE sha256 = ? AND created = ? AND integrity = ? AND checked_at IS ?",
      integrity,
      Date.now(),
      row.sha256,
      row.created,
      row.integrity,
      row.checked_at,
    ).changes;

  async function scan(options: ScrubOptions): Promise<ScrubResult> {
    const started = Date.now();
    const result: ScrubResult = {
      checked: 0,
      bytes: 0,
      missing: 0,
      corrupt: 0,
      errors: 0,
      cancelled: false,
      complete: false,
      nextAfter: options.after ?? null,
      started,
      finished: started,
    };
    current = result;
    const signal = options.signal ? AbortSignal.any([closing.signal, options.signal]) : closing.signal;
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)));
    const maxBytes = Math.max(1, options.maxBytes ?? 256 * 1024 ** 2);
    const maxDurationMs = Math.max(1, options.maxDurationMs ?? 30_000);
    const previous = ctx.db.setting(PROGRESS);
    let chain: ScanProgress | null = options.after ? null : { after: "", started, errors: 0 };
    if (options.after && previous) {
      const saved = JSON.parse(previous) as ScanProgress;
      if (saved.after === options.after) chain = saved;
    }
    // A fresh or unrelated request invalidates an older continuation before doing any work.
    ctx.db.run("DELETE FROM settings WHERE key = ?", PROGRESS);
    let cursor = options.after ?? "";
    try {
      while (!signal.aborted) {
        const row = ctx.db.get<BlobRow>("SELECT * FROM blobs WHERE sha256 > ? ORDER BY sha256 LIMIT 1", cursor);
        if (!row) {
          result.complete = true;
          break;
        }
        if (
          result.checked >= limit ||
          result.bytes >= maxBytes ||
          (result.checked > 0 && Date.now() - started >= maxDurationMs)
        )
          break;
        const check = { sha256: row.sha256, changed: false };
        examining = check;
        let integrity: Integrity = "ok";
        let before: Stats | null = null;
        let readBytes = 0;
        try {
          const file = await open(path(row.sha256), "r");
          try {
            before = await file.stat();
            if (!before.isFile() || before.size !== row.size) integrity = "corrupt";
            else {
              signal.throwIfAborted();
              const hash = createHash("sha256");
              for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
                hash.update(chunk as Buffer);
                readBytes += (chunk as Buffer).length;
              }
              if (readBytes !== row.size || hash.digest("hex") !== row.sha256) integrity = "corrupt";
            }
          } finally {
            await file.close();
          }
        } catch (error) {
          if (signal.aborted) break;
          integrity = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
          if (integrity === "unreadable")
            ctx.log.error({ err: error, blob: row.sha256 }, "blob integrity check unavailable");
        } finally {
          result.bytes += readBytes;
        }
        // Never let a read of an old inode overwrite the result of a concurrent repair or deletion.
        const after = await stat(path(row.sha256)).catch(() => null);
        const unchanged =
          !check.changed &&
          (before ? after !== null && sameFile(before, after) : integrity === "unreadable" || after === null);
        if (signal.aborted) break;
        if (!unchanged) {
          // A concurrent adoption already certifies its new bytes. Otherwise require another pass.
          const latest = ctx.db.get<BlobRow>("SELECT * FROM blobs WHERE sha256 = ?", row.sha256);
          if (latest && (latest.checked_at === row.checked_at || latest.integrity !== "ok")) {
            if (!check.changed) mark(latest, "unreadable");
            result.errors++;
            if (chain) chain.errors++;
          }
        } else if (mark(row, integrity)) {
          if (integrity === "missing") result.missing++;
          else if (integrity === "corrupt") result.corrupt++;
          else if (integrity === "unreadable") {
            result.errors++;
            if (chain) chain.errors++;
          }
        }
        result.checked++;
        cursor = row.sha256;
        result.nextAfter = cursor;
        examining = null;
      }
      result.cancelled = signal.aborted;
      if (result.cancelled) result.complete = false;
      if (result.complete) {
        result.nextAfter = null;
        // A caller-supplied cursor alone cannot certify the skipped prefix. Every surviving row
        // must have been inspected or adopted since the full scan began, including new uploads.
        if (
          chain &&
          chain.errors === 0 &&
          !ctx.db.get(
            "SELECT 1 FROM blobs WHERE integrity = 'unreadable' OR checked_at IS NULL OR checked_at < ? LIMIT 1",
            chain.started,
          )
        )
          ctx.db.setSetting(FULL_CHECK, String(Date.now()));
      } else if (chain && !result.cancelled && cursor) {
        ctx.db.setSetting(PROGRESS, JSON.stringify({ ...chain, after: cursor }));
      }
      return result;
    } finally {
      examining = null;
      result.finished = Date.now();
    }
  }

  const adopt = (file: string | null, sha256: string, size: number, crc32: number) => {
    if (!SHA.test(sha256)) throw new Error("Invalid blob hash.");
    const target = path(sha256);
    const directory = dirname(target);
    const stage = [...(staged.get(sha256) ?? [])].find((entry) => entry.complete && entry.file === file);
    if (!stage && ctx.db.sqlite.isTransaction)
      throw new Error("A blob must be staged before adoption inside a transaction.");
    const name = stage?.name ?? `.${randomUUID()}.tmp`;
    // Synchronous callers must enter here before opening their publication transaction. An
    // intent inserted inside that transaction could disappear while its filesystem writes survive.
    if (!stage) ctx.db.run("INSERT INTO blob_cleanup(sha256, temporary) VALUES(?, ?)", sha256, name);
    changing(sha256);
    try {
      let same = false;
      if (file !== null) {
        const source = statSync(file);
        if (!source.isFile() || source.size !== size) throw new Error("Upload file size does not match its length.");
        try {
          same = sameFile(source, statSync(target));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (!same) {
        mkdirSync(directory, { recursive: true });
        // Another stage can replace the hash path before publication. Reuse this stage's
        // journaled name so a failed relink and unlink remain recoverable after rollback.
        const temporary = join(directory, name);
        try {
          if (file === null) {
            // Empty-file creation has no caller-owned upload part. Its only temporary is covered by
            // the intent above, including a source fsync failure followed by a failed unlink.
            const fd = openSync(temporary, "wx", 0o600);
            try {
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
          } else linkSync(file, temporary);
          renameSync(temporary, target);
        } finally {
          unlinkIfPresent(temporary);
        }
      }
      if (!same) {
        invalidateThumbnails(sha256);
        for (const dir of [root, dirname(directory), directory]) fsyncDirectory(dir);
      }
      const now = Date.now();
      ctx.db.tx(() => {
        ctx.db.run(
          `INSERT INTO blobs(sha256, size, crc32, created, integrity, checked_at) VALUES(?, ?, ?, ?, 'ok', ?)
       ON CONFLICT(sha256) DO UPDATE SET size = excluded.size, crc32 = excluded.crc32, integrity = 'ok', checked_at = excluded.checked_at`,
          sha256,
          size,
          crc32,
          now,
          now,
        );
        ctx.db.run("DELETE FROM blob_cleanup WHERE sha256 = ? AND temporary = ?", sha256, name);
      });
      if (stage) release(sha256, stage);
    } catch (error) {
      if (!stage) collect([sha256]);
      throw error;
    }
  };

  return {
    path,

    async verify(sha256, size) {
      const row = ctx.db.get<BlobRow>("SELECT * FROM blobs WHERE sha256 = ?", sha256);
      if (
        !row ||
        row.integrity === "missing" ||
        row.integrity === "corrupt" ||
        (size !== undefined && size !== row.size)
      )
        return unavailable();
      try {
        const info = await stat(path(sha256));
        if (info.isFile() && info.size === row.size) return;
        mark(row, "corrupt");
      } catch (error) {
        mark(row, (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable");
      }
      return unavailable();
    },

    scrub(options = {}) {
      if (running) fail(409, "A storage integrity check is already running.");
      if (closing.signal.aborted) fail(503, "Storage is closing.");
      if (options.after && !SHA.test(options.after)) fail(400, "Invalid integrity check cursor.");
      for (const value of [options.limit, options.maxBytes, options.maxDurationMs])
        if (value !== undefined && (!Number.isFinite(value) || value <= 0)) fail(400, "Invalid integrity check limit.");
      lastError = false;
      running = scan(options)
        .then((result) => {
          lastResult = result;
          return result;
        })
        .catch((error: unknown) => {
          lastError = true;
          throw error;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },

    status() {
      const counts = ctx.db.get<{
        total: number;
        healthy: number;
        missing: number;
        corrupt: number;
        errors: number;
        lastChecked: number | null;
      }>(
        `SELECT count(*) AS total, coalesce(sum(integrity = 'ok'), 0) AS healthy,
         coalesce(sum(integrity = 'missing'), 0) AS missing, coalesce(sum(integrity = 'corrupt'), 0) AS corrupt,
         coalesce(sum(integrity = 'unreadable'), 0) AS errors, max(checked_at) AS lastChecked FROM blobs`,
      )!;
      return {
        ...counts,
        lastFullCheck: Number(ctx.db.setting(FULL_CHECK)) || null,
        lastResult,
        lastError,
        running: running !== null,
        checked: current?.checked ?? 0,
        bytes: current?.bytes ?? 0,
      };
    },

    degraded: () => lastError || !!ctx.db.get("SELECT 1 FROM blobs WHERE integrity <> 'ok' LIMIT 1"),

    async close() {
      closing.abort();
      await running;
    },

    async stage(file, sha256, expected) {
      if (!SHA.test(sha256)) throw new Error("Invalid blob hash.");
      if (ctx.db.sqlite.isTransaction) throw new Error("Blob staging must begin outside a transaction.");
      const target = path(sha256);
      const directory = dirname(target);
      const name = `.${randomUUID()}.tmp`;
      // This transaction-independent row must precede every staging filesystem write. Publication
      // consumes it in its own transaction; failure or rollback leaves durable work for maintenance.
      ctx.db.run("INSERT INTO blob_cleanup(sha256, temporary) VALUES(?, ?)", sha256, name);
      const stage: Stage = { file, complete: false, name, temporary: null };
      const entries = staged.get(sha256) ?? new Set<Stage>();
      entries.add(stage);
      staged.set(sha256, entries);
      changing(sha256);
      try {
        // Whatever this creates must be synced into its parent, however often that happened before.
        const created = await mkdir(directory, { recursive: true });
        const levels = [sha256.slice(0, 2), `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}`];
        if (created) for (const level of levels.slice(created === directory ? 1 : 0)) durableDirectories.delete(level);
        const temporary = (stage.temporary = join(directory, name));
        try {
          // This file has just been hashed and fsynced by the receiver. Always prefer those proven
          // bytes to an existing hash-named inode, whose contents may have deteriorated since upload.
          await link(file, temporary);
          // The pathname may have been replaced since it was hashed. Check the linked inode itself
          // before it can replace a hash path that other files may already reference.
          if (expected && !sameBytes(expected, await stat(temporary)))
            fail(503, "Upload storage changed before the file could be saved. Retry shortly.");
          await rename(temporary, target);
          changing(sha256);
          await invalidateThumbnailsAsync(sha256);
          // mkdir cannot tell whether a prior attempt created these directories but failed to sync,
          // so a directory this process has not synced into its parent yet is synced once, whoever
          // created it.
          for (const [level, parent] of [
            [levels[0], root],
            [levels[1], dirname(directory)],
          ] as const)
            if (!durableDirectories.has(level)) {
              await fsyncDirectory(parent, true);
              durableDirectories.add(level);
            }
        } finally {
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          stage.temporary = null;
        }
        // When both paths already link the same inode, rename leaves the temporary name intact.
        // Sync after its final unlink so successful adoption cannot forget non-durable cleanup.
        await fsyncDirectory(directory, true);
        stage.complete = true;
      } catch (error) {
        release(sha256, stage);
        collect([sha256]);
        throw error;
      }
    },

    unstage(sha256, file?: string) {
      releaseFile(sha256, file);
      const { errors } = collect([sha256]);
      if (errors.length) throw new AggregateError(errors, "Staged files could not be cleaned up; retry required.");
    },

    adopt,

    adoptEmpty: () => adopt(null, EMPTY_SHA256, 0, 0),

    stageThumbnail(sha256) {
      if (!SHA.test(sha256)) throw new Error("Invalid blob hash.");
      if (ctx.db.sqlite.isTransaction) throw new Error("Thumbnail staging must begin outside a transaction.");
      if (!recorded(sha256)) fail(404, "The stored file is unavailable.");
      const name = `.${randomUUID()}.tmp`;
      const file = join(thumbnails, name);
      ctx.db.run("INSERT INTO blob_cleanup(sha256, temporary, kind) VALUES(?, ?, 'thumbnail')", sha256, name);
      const entries = rendering.get(sha256) ?? new Set<string>();
      entries.add(file);
      rendering.set(sha256, entries);
      let active = true;
      const settle = () => {
        if (!active) return;
        active = false;
        entries.delete(file);
        if (!entries.size) rendering.delete(sha256);
        // Purge may have removed the last node while rendering was leased. Failed publication
        // also invalidates final renditions, preserving the source when another node uses it.
        const { errors } = collect([sha256]);
        if (errors.length) throw new AggregateError(errors, "Thumbnail cleanup failed; retry required.");
      };
      return {
        file,
        finish() {
          if (!active) return;
          // A final rename must be durable before its temporary cleanup record can be forgotten.
          fsyncDirectory(thumbnails);
          ctx.db.run("DELETE FROM blob_cleanup WHERE sha256 = ? AND temporary = ?", sha256, name);
          settle();
        },
        discard: settle,
      };
    },

    collect(candidates) {
      const { errors } = collect(candidates);
      if (errors.length) throw new AggregateError(errors, "Stored files could not be cleaned up; retry required.");
    },

    sweep() {
      // Bound work by inspected rows, not only matches. Advance past failures and active uploads so
      // a stubborn first candidate cannot starve later cleanup; the next pass retries retained rows.
      const rows = ctx.db.all<{ sha256: string }>(
        `SELECT sha256 FROM blobs WHERE sha256 > ?
         UNION SELECT sha256 FROM blob_cleanup WHERE sha256 > ? ORDER BY sha256 LIMIT 100`,
        sweepAfter,
        sweepAfter,
      );
      sweepAfter = rows.length === 100 ? rows[rows.length - 1].sha256 : "";
      const { errors } = collect(rows.map((row) => row.sha256));
      if (errors.length) throw new AggregateError(errors, "Stored files could not be cleaned up; retry required.");
    },

    async reconcile() {
      // Only unreferenced blobs and pending cleanup have work to do; `collect` rechecks each one.
      const collected = collect(
        ctx.db
          .all<{ sha256: string }>(
            `SELECT sha256 FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.blob = b.sha256)
             UNION SELECT sha256 FROM blob_cleanup`,
          )
          .map((r) => r.sha256),
      );
      const errors = collected.errors;
      const found = new Set<string>();
      let removedFiles = collected.removedFiles;
      const remove = (file: string) => {
        try {
          if (unlinkIfPresent(file)) removedFiles++;
          fsyncDirectory(dirname(file));
        } catch (error) {
          ctx.log.error({ err: error }, "orphan file cleanup failed; retry required");
          errors.push(error);
        }
      };
      const temporary = (file: string) =>
        [...staged.values()].some((entries) => [...entries].some((stage) => stage.temporary === file));
      await eachFile(root, (directory, name) => {
        const file = join(directory, name);
        // Recheck live rows and stage leases immediately before each synchronous unlink. Adoption
        // can run while readdir awaits, so a snapshot of known rows is not sufficient protection.
        if (SHA.test(name) && directory === dirname(path(name)) && (recorded(name) || leased(name))) found.add(name);
        else if (!temporary(file)) remove(file);
      });
      for (const name of await readdir(thumbnails)) {
        const file = join(thumbnails, name);
        if ([...rendering.values()].some((entries) => entries.has(file))) continue;
        const match = THUMBNAIL_FILE.exec(name);
        if (!match || (!recorded(match[1]) && !leased(match[1]))) remove(file);
      }
      const missing: string[] = [];
      for (const { sha256 } of ctx.db.all<{ sha256: string }>("SELECT sha256 FROM blobs")) {
        if (found.has(sha256) || staging(sha256)) continue;
        // A new adoption may have followed the directory listing. Check its current path before
        // marking it missing; no await can interleave this check with the status update below.
        try {
          statSync(path(sha256));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(sha256);
          else errors.push(error);
        }
      }
      for (const sha256 of missing)
        ctx.db.run("UPDATE blobs SET integrity = 'missing', checked_at = ? WHERE sha256 = ?", Date.now(), sha256);
      if (errors.length) throw new AggregateError(errors, "Storage reconciliation failed; retry required.");
      return { removedFiles, missing };
    },
  };
}
