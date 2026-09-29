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
import { bodyOf, contentDisposition, inlineHeaders, safePreviewMime, send } from "./serve.ts";
import { createThumbnails } from "./thumbnails.ts";
import { zipLayout, type ZipEntry } from "./zip.ts";

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

// ZIP assembly keeps each entry's path and central-directory record in memory. Bound an archive
// independently of how many transfers have been appended to an item over its lifetime.
export const MAX_ZIP_ENTRIES = 20_000;
export const MAX_ZIP_TEXT_BYTES = LIMITS.manifestBytes;

const NODE = "SELECT id, item, name, kind, size, mime, blob, text FROM nodes WHERE id = ? AND state = 'ready'";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type Params = { id: string; token: string; node: string };
type Query = { inline?: string; folder?: string };

export function registerDownloads(app: FastifyInstance, ctx: Context) {
  const thumbnail = createThumbnails(ctx);

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
   * A download is a GET for a file saved rather than previewed, or a ZIP. Resuming one (a Range
   * past the start) is the same download, and HEAD fetches nothing.
   */
  const counted = (req: FastifyRequest, access: ShareAccess, attachment: boolean) => {
    const range = req.headers.range;
    if (req.method === "GET" && attachment && (!range || /^bytes=0-/.test(range))) ctx.links.downloaded(access);
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

  async function content(req: FastifyRequest, reply: FastifyReply, node: NodeRow, onSent: Meter) {
    const inline = (req.query as Query).inline === "1";
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
    const folderId = (req.query as Query).folder;
    const folder = folderId
      ? (ctx.db.get<{ name: string }>(
          "SELECT name FROM nodes WHERE id = ? AND item = ? AND kind = 'folder'",
          folderId,
          itemId,
        ) ?? notFound("That folder"))
      : null;
    const rows = ctx.db.all<TreeRow>(
      // The walk carries every column: joining back to nodes lets the planner scan the whole table.
      `WITH RECURSIVE tree(id, path, kind, size, blob, created) AS (
         SELECT id, name, kind, size, blob, created
         FROM nodes WHERE ${folder ? "id = ?" : "item = ? AND parent IS NULL"} AND state = 'ready'
         UNION ALL
         SELECT n.id, tree.path || '/' || n.name, n.kind, n.size, n.blob, n.created
         FROM nodes n JOIN tree ON n.parent = tree.id WHERE n.state = 'ready'
         LIMIT ${MAX_ZIP_ENTRIES + 1}
       )
       SELECT tree.id, tree.path, tree.kind, tree.size, tree.blob, tree.created, b.crc32
       FROM tree LEFT JOIN blobs b ON b.sha256 = tree.blob
       ORDER BY tree.path`,
      folderId ?? itemId,
    );
    if (!rows.length) fail(404, "There is nothing here to download.");
    if (rows.length > MAX_ZIP_ENTRIES) fail(413, "This folder has too many entries to download as a ZIP.");
    const textBytes = rows.reduce((sum, row) => sum + (row.kind === "text" ? row.size : 0), 0);
    if (textBytes > MAX_ZIP_TEXT_BYTES) fail(413, "This folder has too much text to download as a ZIP.");
    // Do not fan out a stat for every file in a large archive; many simultaneous filesystem
    // operations can exhaust the libuv queue or storage device.
    for (const row of rows) if (row.kind === "file") await ctx.blobs.verify(row.blob!, row.size);
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
    const entries = rows.map((r): ZipEntry => {
      const base = { path: r.path, created: r.created };
      if (r.kind === "folder") return { ...base, kind: "folder" };
      if (r.kind === "text") return { ...base, kind: "text", data: Buffer.from(texts.get(r.id) ?? "", "utf8") };
      return { ...base, kind: "file", size: r.size, crc32: r.crc32!, file: ctx.blobs.path(r.blob!) };
    });
    const layout = zipLayout(entries);
    const etag = hash(JSON.stringify(rows.map((r) => [r.id, r.path, r.kind, r.blob, r.size, r.created])));
    const name =
      folder?.name ??
      ctx.library.summaries([itemId]).get(itemId)?.name ??
      fail(410, "This item's recovery period has ended.");
    reply.type("application/zip").header("Content-Disposition", contentDisposition("attachment", `${name}.zip`));
    return send(req, reply, { ...layout, etag }, onSent);
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
        done(null, payload);
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
