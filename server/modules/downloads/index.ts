// Every byte-stream download: node content, thumbnails and ZIP archives, for the owner and through
// share links. A node is served only when it is ready and belongs to the caller or the link's item.
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { LIMITS } from "../../../shared/model.ts";
import type { Context, ShareAccess } from "../../context.ts";
import { currentMember, requireMember } from "../../lib/auth.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { ownedReadable } from "../library/items.ts";
import { bodyOf, contentDisposition, inlineHeaders, safePreviewMime, send, whileAllowed } from "./serve.ts";
import { createThumbnails } from "./thumbnails.ts";
import { crc32 } from "node:zlib";
import { validTimeZone, zipPlan, type ZipContent, type ZipEntry, type ZipPlan } from "./zip.ts";

type NodeRow = {
  id: string;
  item: string;
  name: string;
  kind: "file" | "folder" | "text";
  size: number;
  mime: string;
  blob: string | null;
  text: string | null;
};
type TreeRow = Omit<NodeRow, "item" | "name" | "mime" | "text"> & {
  path: string;
  created: number;
  crc32: number | null;
};

// An archive holds every entry of an item, however many transfers added to it; its headers are
// written as they are sent. Its texts are all read to measure them, so their total is bounded.
export const MAX_ZIP_TEXT_BYTES = LIMITS.manifestBytes;

/**
 * A ZIP worked out once: where every byte goes, after checking each file is on disk. Working it out
 * costs a little for every file, so a HEAD, a resumed download or a download manager's many ranges
 * reuse it while the item's ready contents (`content_version`) and the server's list of damaged
 * copies stay as they were, for at most PREPARED_MS before the files are checked again.
 */
type Prepared = { version: number; degraded: number; made: number; rows: number; plan: ZipPlan; digest: string };
export const PREPARED_MS = 60_000;
/** Entries kept across all prepared ZIPs; the least recently used go first. One full item fits. */
const PREPARED_ROWS = 100_000;

const NODE = "SELECT id, item, name, kind, size, mime, blob, text FROM nodes WHERE id = ? AND state = 'ready'";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type Params = { id: string; token: string; node: string };
type Query = { inline?: string; folder?: string; tz?: string };

export function registerDownloads(app: FastifyInstance, ctx: Context) {
  const thumbnail = createThumbnails(ctx);
  app.addHook("onClose", () => thumbnail.close());

  const signedIn = (req: FastifyRequest) => currentMember(ctx, req) ?? fail(401, "Sign in to continue.");
  const ownedItem = (req: FastifyRequest, id: string) => ownedReadable(ctx, signedIn(req).userId, id);
  const ownedNode = (req: FastifyRequest, id: string) => {
    const owner = signedIn(req).userId;
    const node = ctx.db.get<NodeRow>(`${NODE} AND owner = ?`, id, owner) ?? notFound("That file");
    ownedReadable(ctx, owner, node.item);
    return node;
  };
  const sharedNode = (access: ShareAccess, id: string) =>
    ctx.db.get<NodeRow>(`${NODE} AND item = ?`, id, access.itemId) ?? notFound("That file");
  const shareAccess = (req: FastifyRequest<{ Params: Params }>) => {
    const access = ctx.links.content(req.params.token, req);
    // authOf caches the initial member. Its password bypass must not survive session revocation.
    if (access.byOwner) signedIn(req);
    return access;
  };
  /**
   * A download is a GET for a whole file saved rather than previewed, or a ZIP. Resuming one (a Range
   * past the start) is the same download and HEAD fetches nothing. A browser saving a file asks for
   * all of it or for `bytes=0-`; a range with an end is a page reading part of a file (the share
   * page's text excerpt reads the first 4 KiB), not someone downloading it.
   */
  const counted = (req: FastifyRequest, access: ShareAccess, attachment: boolean) => {
    const range = req.headers.range?.trim();
    if (req.method === "GET" && attachment && (!range || range === "bytes=0-")) ctx.links.downloaded(access);
  };

  /** Bytes a member took from their own Files, or that a link delivered on their behalf. */
  type Meter = (bytes: number) => void;
  const ownDownload =
    (req: FastifyRequest): Meter =>
    (bytes) =>
      ctx.usage.add(requireMember(ctx, req).userId, { downloaded: bytes });
  const sharedDownload =
    (access: ShareAccess): Meter =>
    (bytes) =>
      ctx.usage.add(access.owner, access.byOwner ? { downloaded: bytes } : { shared: bytes });

  async function content(req: FastifyRequest, reply: FastifyReply, node: NodeRow, meter: Meter) {
    const inline = (req.query as Query).inline === "1";
    // Looking at a file in the app isn't taking it away, so previews aren't counted as downloads.
    const onSent = inline ? undefined : meter;
    if (node.kind === "folder") fail(400, "Download a folder as a ZIP file.");
    if (node.kind === "text") {
      const data = Buffer.from(node.text ?? "", "utf8");
      reply
        .type("text/plain; charset=utf-8")
        .header("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", node.name));
      if (inline) inlineHeaders(reply, "text/plain");
      return send(req, reply, bodyOf([{ length: data.length, data }], hash(data)), onSent);
    }
    await ctx.blobs.verify(node.blob!, node.size);
    const type = inline ? safePreviewMime(node.mime, node.name) : null;
    reply
      .type(type ?? "application/octet-stream")
      .header("Content-Disposition", contentDisposition(type ? "inline" : "attachment", node.name));
    if (type) inlineHeaders(reply, type);
    return send(req, reply, bodyOf([{ length: node.size, file: ctx.blobs.path(node.blob!) }], node.blob!), onSent);
  }

  /** The whole item, or one folder's subtree rooted at the folder's name. Only ready nodes. */
  async function zip(req: FastifyRequest, reply: FastifyReply, itemId: string, onSent: Meter) {
    // A repeated parameter arrives as a list, which isn't one folder.
    const asked = (req.query as Record<string, unknown>).folder;
    const folderId = asked === undefined || typeof asked === "string" ? asked : notFound("That folder");
    const folder = folderId
      ? (ctx.db.get<{ name: string }>(
          "SELECT name FROM nodes WHERE id = ? AND item = ? AND kind = 'folder'",
          folderId,
          itemId,
        ) ?? notFound("That folder"))
      : null;
    const ready = await preparedZip(itemId, folderId ?? null);
    const name =
      folder?.name ??
      ctx.library.summaries([itemId]).get(itemId)?.name ??
      fail(410, "This item's recovery period has ended.");
    // MS-DOS times have no time zone, so they are written in the downloader's, as their unzip expects.
    const timeZone = validTimeZone((req.query as Query).tz);
    const etag = hash(`${ready.digest}\n${timeZone ?? ""}`);
    reply.type("application/zip").header("Content-Disposition", contentDisposition("attachment", `${name}.zip`));
    return send(req, reply, { ...ready.plan.body(timeZone), etag }, onSent);
  }

  const prepared = new Map<string, Prepared>();
  let preparedRows = 0;
  const preparing = new Map<string, Promise<Prepared>>();
  const working = new Map<string, Promise<unknown>>();

  /** One item's ZIPs are worked out one at a time, so asking for many folders at once gains nothing. */
  function oneAtATime<T>(itemId: string, work: () => Promise<T>): Promise<T> {
    const run = (working.get(itemId) ?? Promise.resolve()).then(work);
    const settled = run.then(
      () => {},
      () => {},
    );
    working.set(itemId, settled);
    void settled.then(() => {
      if (working.get(itemId) === settled) working.delete(itemId);
    });
    return run;
  }

  /** The item's (or folder's) ZIP, worked out again only when something it depends on changed. */
  function preparedZip(itemId: string, folderId: string | null): Promise<Prepared> {
    const key = `${itemId}/${folderId ?? ""}`;
    const cached = prepared.get(key);
    if (cached && fresh(itemId, cached)) {
      prepared.delete(key);
      prepared.set(key, cached);
      return Promise.resolve(cached);
    }
    let pending = preparing.get(key);
    if (!pending) {
      // Everyone asking while it's worked out waits for the same answer.
      pending = oneAtATime(itemId, () => prepareZip(itemId, folderId)).finally(() => preparing.delete(key));
      preparing.set(key, pending);
      void pending.then(
        (ready) => remember(key, ready),
        () => {},
      );
    }
    return pending;
  }

  const contentVersion = (itemId: string) =>
    ctx.db.value<number>("SELECT content_version FROM items WHERE id = ?", itemId) ?? -1;
  // Damaged copies are few and indexed: any change to the list means a file may have gone.
  const degradedCopies = () => ctx.db.value<number>("SELECT count(*) FROM blobs WHERE integrity <> 'ok'") ?? 0;
  const fresh = (itemId: string, ready: Prepared) =>
    Date.now() - ready.made < PREPARED_MS &&
    ready.version === contentVersion(itemId) &&
    ready.degraded === degradedCopies();

  function remember(key: string, ready: Prepared) {
    if (ready.rows > PREPARED_ROWS) return;
    const old = prepared.get(key);
    if (old) preparedRows -= old.rows;
    prepared.delete(key);
    prepared.set(key, ready);
    preparedRows += ready.rows;
    for (const [oldest, entry] of prepared) {
      if (preparedRows <= PREPARED_ROWS) break;
      prepared.delete(oldest);
      preparedRows -= entry.rows;
    }
  }

  async function prepareZip(itemId: string, folderId: string | null): Promise<Prepared> {
    // Read first: a change while the files are checked makes the next request work it out again.
    const version = contentVersion(itemId);
    const degraded = degradedCopies();
    const made = Date.now();
    const rows = ctx.db.all<TreeRow>(
      // The walk carries every column: joining back to nodes lets the planner scan the whole table.
      `WITH RECURSIVE tree(id, path, kind, size, blob, created) AS (
         SELECT id, name, kind, size, blob, created
         FROM nodes WHERE ${folderId ? "id = ? AND item = ?" : "item = ? AND parent IS NULL"} AND state = 'ready'
         UNION ALL
         SELECT n.id, tree.path || '/' || n.name, n.kind, n.size, n.blob, n.created
         FROM nodes n JOIN tree ON n.parent = tree.id WHERE n.state = 'ready'
       )
       SELECT tree.id, tree.path, tree.kind, tree.size, tree.blob, tree.created, b.crc32
       FROM tree LEFT JOIN blobs b ON b.sha256 = tree.blob
       ORDER BY tree.path`,
      ...(folderId ? [folderId, itemId] : [itemId]),
    );
    if (!rows.length) fail(404, "There is nothing here to download.");
    const textBytes = rows.reduce((sum, row) => sum + (row.kind === "text" ? row.size : 0), 0);
    if (textBytes > MAX_ZIP_TEXT_BYTES) fail(413, "This folder has too much text to download as a ZIP.");
    // Do not fan out a stat for every file in a large archive; many simultaneous filesystem
    // operations can exhaust the libuv queue or storage device.
    for (const row of rows) if (row.kind === "file") await ctx.blobs.verify(row.blob!, row.size);
    // Texts are measured now and read again only when their bytes are sent, so a prepared ZIP
    // holds no text. Saved texts never change.
    const textRows = new Map(rows.filter((row) => row.kind === "text").map((row) => [row.id, row]));
    if (textRows.size)
      for (const { id, text } of ctx.db.all<{ id: string; text: string | null }>(
        "SELECT id, text FROM nodes WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify([...textRows.keys()]),
      )) {
        const row = textRows.get(id)!;
        const data = Buffer.from(text ?? "", "utf8");
        row.size = data.length;
        row.crc32 = crc32(data);
      }
    const entries: ZipEntry[] = rows;
    const content = (index: number): ZipContent => {
      const row = rows[index];
      if (row.kind !== "text") return { file: ctx.blobs.path(row.blob!) };
      const text = ctx.db.value<string>("SELECT text FROM nodes WHERE id = ? AND state = 'ready'", row.id);
      const data = Buffer.from(text ?? "", "utf8");
      // Gone with its item: end the archive rather than send something else under its header.
      if (text === undefined || data.length !== row.size) throw new Error("A text in this archive is no longer there.");
      return { data };
    };
    const digest = createHash("sha256");
    for (const r of rows) digest.update(JSON.stringify([r.id, r.path, r.kind, r.blob, r.size, r.created]));
    return {
      version,
      degraded,
      made,
      rows: rows.length,
      plan: zipPlan(entries, content),
      digest: digest.digest("hex"),
    };
  }

  // GET and HEAD share a handler: the automatic HEAD route would replace Content-Length with 0.
  const stream = (
    url: string,
    authorize: (req: FastifyRequest<{ Params: Params }>) => unknown,
    handler: (req: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => unknown,
  ) =>
    app.route<{ Params: Params }>({
      method: ["GET", "HEAD"],
      url,
      handler,
      onSend(req, reply, payload, done) {
        // Preparation can await disk verification or image rendering. Recheck at the last
        // synchronous boundary before serving, including HEAD and conditional thumbnail 304s.
        if (reply.statusCode < 400) {
          try {
            authorize(req);
          } catch (error) {
            if (payload instanceof Readable) payload.destroy();
            for (const name of [
              "Content-Type",
              "Content-Length",
              "Content-Range",
              "Content-Disposition",
              "ETag",
              "Accept-Ranges",
            ])
              reply.removeHeader(name);
            reply.header("Cache-Control", "no-store");
            done(error as Error);
            return;
          }
        }
        // Taking access away also stops a download already running, within a megabyte or a second.
        done(
          null,
          whileAllowed(payload, () => authorize(req)),
        );
      },
    });

  stream(
    "/api/nodes/:id/content",
    (req) => ownedNode(req, req.params.id),
    (req, reply) => content(req, reply, ownedNode(req, req.params.id), ownDownload(req)),
  );
  stream(
    "/api/nodes/:id/thumbnail",
    (req) => ownedNode(req, req.params.id),
    (req, reply) => thumbnail(req, reply, ownedNode(req, req.params.id)),
  );
  stream(
    "/api/items/:id/zip",
    (req) => ownedItem(req, req.params.id),
    (req, reply) => {
      ownedItem(req, req.params.id);
      return zip(req, reply, req.params.id, ownDownload(req));
    },
  );
  // Every share route asks the link first: its password, and who it lets in.
  stream(
    "/api/s/:token/nodes/:node/content",
    (req) => sharedNode(shareAccess(req), req.params.node),
    (req, reply) => {
      const access = shareAccess(req);
      const node = sharedNode(access, req.params.node);
      counted(req, access, (req.query as Query).inline !== "1" && node.kind !== "folder");
      return content(req, reply, node, sharedDownload(access));
    },
  );
  stream(
    "/api/s/:token/nodes/:node/thumbnail",
    (req) => sharedNode(shareAccess(req), req.params.node),
    (req, reply) => {
      const access = shareAccess(req);
      return thumbnail(req, reply, sharedNode(access, req.params.node));
    },
  );
  stream("/api/s/:token/zip", shareAccess, (req, reply) => {
    const access = shareAccess(req);
    counted(req, access, true);
    return zip(req, reply, access.itemId, sharedDownload(access));
  });
}
