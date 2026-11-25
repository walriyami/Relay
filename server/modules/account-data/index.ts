// What a member keeps, for their Settings → Storage section, and all of it as one ZIP so they can
// take their files with them (before leaving, or before an administrator removes the account).
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { api, urls } from "../../../shared/api.ts";
import type { StorageOverview } from "../../../shared/model.ts";
import type { Context } from "../../context.ts";
import { currentMember } from "../../lib/auth.ts";
import { fail, HttpError } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { preparing } from "../../lib/jobs.ts";
import { usageOf } from "../auth/sessions.ts";
import { MAX_ZIP_TEXT_BYTES } from "../downloads/index.ts";
import { contentDisposition, send, whileAllowed } from "../downloads/serve.ts";
import { validTimeZone, zipLayout, type ZipContent, type ZipEntry } from "../downloads/zip.ts";

type Row = {
  id: string;
  item: string;
  top: string;
  path: string;
  kind: "file" | "folder" | "text";
  size: number;
  blob: string | null;
  created: number;
  crc32: number | null;
};

const LARGEST = 5;

export function storageOverview(ctx: Context, userId: string): StorageOverview {
  const usage = usageOf(ctx, userId);
  const trash = ctx.db.get<{ items: number; bytes: number }>(
    `SELECT COUNT(DISTINCT i.id) AS items, ifnull(SUM(n.size), 0) AS bytes
     FROM items i LEFT JOIN nodes n ON n.item = i.id AND n.state = 'ready'
     WHERE i.owner = ? AND i.trashed IS NOT NULL`,
    userId,
  )!;
  const largest = ctx.db.all<{ id: string; bytes: number }>(
    `SELECT i.id, sum(n.size) AS bytes FROM items i JOIN nodes n ON n.item = i.id
     WHERE i.owner = ? AND i.trashed IS NULL AND n.state = 'ready'
     GROUP BY i.id HAVING bytes > 0 ORDER BY bytes DESC, i.id LIMIT ${LARGEST}`,
    userId,
  );
  const names = ctx.library.summaries(largest.map((item) => item.id));
  return {
    ...usage,
    limit: ctx.db.value<number | null>("SELECT quota FROM users WHERE id = ?", userId) ?? null,
    trash,
    items: ctx.db.value<number>("SELECT COUNT(*) FROM items WHERE owner = ? AND trashed IS NULL", userId)!,
    largest: largest.map((item) => ({ ...item, name: names.get(item.id)?.name ?? "" })),
  };
}

/** A name that is one path segment in every unzip tool. */
const segment = (name: string) => {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what's replaced.
  const clean = name.replace(/[/\\\x00-\x1f\x7f]/g, "-").trim();
  return !clean || clean === "." || clean === ".." ? "Untitled" : clean;
};

/** "photo.jpg" → "photo (2).jpg"; folders and names without an extension get the number at the end. */
function numbered(name: string, n: number, folder: boolean) {
  const dot = folder ? -1 : name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/**
 * Every item in Files (not Trash): an item holding one thing puts it at the top of the archive;
 * an item holding several gets a folder with the item's name. Names that collide get a number.
 */
export function exportEntries(ctx: Context, owner: string) {
  const now = Date.now();
  const rows = ctx.db.all<Row>(
    `WITH RECURSIVE tree(id, item, top, path, kind, size, blob, created) AS (
       SELECT n.id, n.item, n.id, n.name, n.kind, n.size, n.blob, n.created
       FROM items i JOIN nodes n ON n.item = i.id
       WHERE i.owner = ? AND i.trashed IS NULL AND (i.expires IS NULL OR i.expires > ?)
         AND n.parent IS NULL AND n.state = 'ready'
       UNION ALL
       SELECT n.id, tree.item, tree.top, tree.path || '/' || n.name, n.kind, n.size, n.blob, n.created
       FROM nodes n JOIN tree ON n.parent = tree.id WHERE n.state = 'ready'
     )
     SELECT tree.*, b.crc32 FROM tree LEFT JOIN blobs b ON b.sha256 = tree.blob
     ORDER BY tree.item, tree.path`,
    owner,
    now,
  );
  if (!rows.length) fail(404, "There are no files to download yet.");
  const textBytes = rows.reduce((sum, row) => sum + (row.kind === "text" ? row.size : 0), 0);
  if (textBytes > MAX_ZIP_TEXT_BYTES)
    fail(413, "Your notes are too large to download in one ZIP. Download your items one at a time from Files.");

  const byItem = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byItem.get(row.item);
    if (list) list.push(row);
    else byItem.set(row.item, [row]);
  }
  const names = ctx.library.summaries([...byItem.keys()]);
  const taken = new Set<string>();
  // The number after the last one each name was given, so many items with one name stay quick to
  // number rather than counting from 2 for each.
  const next = new Map<string, number>();
  const claim = (name: string, folder: boolean) => {
    const base = segment(name);
    let candidate = base;
    if (taken.has(candidate.toLowerCase())) {
      const key = `${folder ? "/" : ""}${base.toLowerCase()}`;
      let n = next.get(key) ?? 2;
      while (taken.has((candidate = numbered(base, n, folder)).toLowerCase())) n++;
      next.set(key, n + 1);
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  };
  const placed: { row: Row; path: string }[] = [];
  const wrappers: ZipEntry[] = [];
  // Oldest items first, so a collision numbers the newer copy.
  const items = [...byItem.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [itemId, itemRows] of items) {
    const tops = itemRows.filter((row) => row.id === row.top);
    if (tops.length === 1) {
      const root = claim(tops[0].path, tops[0].kind === "folder");
      for (const row of itemRows) placed.push({ row, path: root + row.path.slice(tops[0].path.length) });
    } else {
      const folder = claim(names.get(itemId)?.name ?? "Untitled", true);
      wrappers.push({
        path: folder,
        created: itemRows.reduce((min, row) => Math.min(min, row.created), Infinity),
        kind: "folder",
        size: 0,
        crc32: null,
      });
      for (const row of itemRows) placed.push({ row, path: `${folder}/${row.path}` });
    }
  }
  return { rows, placed, wrappers };
}

/**
 * An export worked out a moment ago, kept for EXPORT_KEPT_MS so the HEAD a browser or download
 * manager sends first, a resumed download or several ranges don't check every file on disk again.
 * It is used only while what it lists (`etag`) and the server's list of damaged copies are the same.
 */
type Exported = { etag: string; degraded: number; made: number; layout: ReturnType<typeof zipLayout> };
export const EXPORT_KEPT_MS = 60_000;
/** Exports larger than this are worked out each time rather than kept in memory. */
const EXPORT_KEPT_ENTRIES = 100_000;

export function registerAccountData(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.storage, ({ member }) => storageOverview(ctx, member.userId));
  const exported = new Map<string, Exported>();
  const degradedCopies = () => ctx.db.value<number>("SELECT count(*) FROM blobs WHERE integrity <> 'ok'") ?? 0;

  const signedIn = (req: FastifyRequest) => currentMember(ctx, req) ?? fail(401, "Sign in to continue.");
  // GET and HEAD share a handler, as in downloads: the automatic HEAD route would drop the length.
  app.route({
    method: ["GET", "HEAD"],
    url: urls.exportZip(),
    async handler(req, reply) {
      const member = signedIn(req);
      // Listing everything and checking each file on disk is the costly part, so it takes one of
      // the few places for that; sending the archive afterwards doesn't hold one.
      const { layout, etag } = await preparing(ctx, reply, member.userId, async () => {
        const { rows, placed, wrappers } = exportEntries(ctx, member.userId);
        // MS-DOS times have no time zone, so they are written in the downloader's, as for any other ZIP.
        const timeZone = validTimeZone((req.query as { tz?: string }).tz);
        const etag = createHash("sha256")
          .update(timeZone ?? "")
          .update(JSON.stringify(placed.map(({ row, path }) => [row.id, path, row.blob, row.size, row.created])))
          .digest("hex");
        const degraded = degradedCopies();
        const now = Date.now();
        for (const [key, kept] of exported) if (now - kept.made >= EXPORT_KEPT_MS) exported.delete(key);
        const kept = exported.get(member.userId);
        if (kept && kept.etag === etag && kept.degraded === degraded) return kept;
        for (const { row } of placed) if (row.kind === "file") await ctx.blobs.verify(row.blob!, row.size);
        const textRows = rows.filter((row) => row.kind === "text");
        const texts = new Map(
          textRows.length
            ? ctx.db
                .all<{ id: string; text: string | null }>(
                  "SELECT id, text FROM nodes WHERE id IN (SELECT value FROM json_each(?))",
                  JSON.stringify(textRows.map((row) => row.id)),
                )
                .map((row) => [row.id, row.text ?? ""])
            : [],
        );
        const data = new Map(textRows.map((row) => [row.id, Buffer.from(texts.get(row.id) ?? "", "utf8")]));
        type Entry = ZipEntry & { content: ZipContent | null };
        const entries: Entry[] = [
          ...wrappers.map((wrapper) => ({ ...wrapper, content: null })),
          ...placed.map(({ row, path }): Entry => {
            const base = { path, created: row.created, kind: row.kind, size: row.size, crc32: row.crc32 };
            if (row.kind === "folder") return { ...base, content: null };
            if (row.kind === "text") return { ...base, content: { data: data.get(row.id)! } };
            return { ...base, content: { file: ctx.blobs.path(row.blob!) } };
          }),
        ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const made: Exported = {
          etag,
          degraded,
          made: now,
          layout: zipLayout(entries, (index) => entries[index].content!, timeZone),
        };
        // One per member: the last one asked for, which is the one a HEAD is followed by.
        if (entries.length <= EXPORT_KEPT_ENTRIES) {
          exported.set(member.userId, made);
          setTimeout(() => {
            if (exported.get(member.userId) === made) exported.delete(member.userId);
          }, EXPORT_KEPT_MS).unref();
        } else exported.delete(member.userId);
        return made;
      });
      const date = new Date().toISOString().slice(0, 10);
      reply
        .type("application/zip")
        .header("Content-Disposition", contentDisposition("attachment", `Relay - ${member.username} - ${date}.zip`));
      // Counted like any other ZIP from Files, so Usage shows what left the server.
      return send(req, reply, { ...layout, etag }, (bytes) => ctx.usage.add(member.userId, { downloaded: bytes }));
    },
    onSend(req, reply, payload, done) {
      // Verifying files awaits the disk; a session revoked meanwhile gets nothing.
      if (reply.statusCode < 400 && !currentMember(ctx, req)) {
        if (payload instanceof Readable) payload.destroy();
        for (const name of ["Content-Type", "Content-Length", "Content-Range", "Content-Disposition", "ETag"])
          reply.removeHeader(name);
        reply.header("Cache-Control", "no-store");
        done(new HttpError(401, "Sign in to continue."));
        return;
      }
      // Signing out or suspending also stops an export already running, as for any download.
      done(
        null,
        whileAllowed(payload, () => signedIn(req)),
      );
    },
  });
}
