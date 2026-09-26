// Every byte-stream download: node content, thumbnails and ZIP archives, for the owner and through
// share links. A node is served only when it is ready and belongs to the caller or the link's item.
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Context, ShareAccess } from "../../context.ts";
import { requireMember } from "../../lib/auth.ts";
import { fail, notFound } from "../../lib/errors.ts";
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
type TreeRow = Omit<NodeRow, "item" | "name" | "mime"> & { path: string; created: number; crc32: number | null };

const NODE = "SELECT id, item, name, kind, size, mime, blob, text FROM nodes WHERE id = ? AND state = 'ready'";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type Params = { id: string; token: string; node: string };
type Query = { inline?: string; folder?: string };

export function registerDownloads(app: FastifyInstance, ctx: Context) {
  const thumbnail = createThumbnails(ctx);

  const ownedNode = (req: FastifyRequest, id: string) =>
    ctx.db.get<NodeRow>(`${NODE} AND owner = ?`, id, requireMember(ctx, req).userId) ?? notFound("That file");
  const sharedNode = (access: ShareAccess, id: string) =>
    ctx.db.get<NodeRow>(`${NODE} AND item = ?`, id, access.itemId) ?? notFound("That file");
  /**
   * A download is a GET for a file saved rather than previewed, or a ZIP. Resuming one (a Range
   * past the start) is the same download, and HEAD fetches nothing.
   */
  const counted = (req: FastifyRequest, access: ShareAccess, attachment: boolean) => {
    const range = req.headers.range;
    if (req.method === "GET" && attachment && (!range || /^bytes=0-/.test(range))) ctx.links.downloaded(access);
  };

  /** Refuses to stream a blob whose file is missing or not the size the database records. */
  const verify = async (sha256: string, size: number) => {
    const info = await stat(ctx.blobs.path(sha256)).catch(() => null);
    if (info?.size === size) return;
    ctx.log.error({ blob: sha256 }, "stored blob is missing or has the wrong size");
    fail(500, "A stored file is unavailable. Contact the administrator.");
  };

  async function content(req: FastifyRequest, reply: FastifyReply, node: NodeRow) {
    const inline = (req.query as Query).inline === "1";
    if (node.kind === "folder") fail(400, "Download a folder as a ZIP file.");
    if (node.kind === "text") {
      const data = Buffer.from(node.text ?? "", "utf8");
      reply
        .type("text/plain; charset=utf-8")
        .header("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", node.name));
      if (inline) inlineHeaders(reply, "text/plain");
      return send(req, reply, bodyOf([{ length: data.length, data }], hash(data)));
    }
    await verify(node.blob!, node.size);
    const type = inline ? safePreviewMime(node.mime, node.name) : null;
    reply
      .type(type ?? "application/octet-stream")
      .header("Content-Disposition", contentDisposition(type ? "inline" : "attachment", node.name));
    if (type) inlineHeaders(reply, type);
    return send(req, reply, bodyOf([{ length: node.size, file: ctx.blobs.path(node.blob!) }], node.blob!));
  }

  /** The whole item, or one folder's subtree rooted at the folder's name. Only ready nodes. */
  async function zip(req: FastifyRequest, reply: FastifyReply, itemId: string) {
    const folderId = (req.query as Query).folder;
    const folder = folderId
      ? (ctx.db.get<{ name: string }>(
          "SELECT name FROM nodes WHERE id = ? AND item = ? AND kind = 'folder'",
          folderId,
          itemId,
        ) ?? notFound("That folder"))
      : null;
    const rows = ctx.db.all<TreeRow>(
      `WITH RECURSIVE tree(id, path) AS (
         SELECT id, name FROM nodes WHERE ${folder ? "id = ?" : "item = ? AND parent IS NULL"} AND state = 'ready'
         UNION ALL
         SELECT n.id, tree.path || '/' || n.name FROM nodes n JOIN tree ON n.parent = tree.id WHERE n.state = 'ready'
       )
       SELECT n.id, tree.path, n.kind, n.size, n.blob, n.text, n.created, b.crc32
       FROM tree JOIN nodes n ON n.id = tree.id LEFT JOIN blobs b ON b.sha256 = n.blob
       ORDER BY tree.path`,
      folderId ?? itemId,
    );
    if (!rows.length) fail(404, "There is nothing here to download.");
    await Promise.all(rows.filter((r) => r.kind === "file").map((r) => verify(r.blob!, r.size)));
    const entries = rows.map((r): ZipEntry => {
      const base = { path: r.path, created: r.created };
      if (r.kind === "folder") return { ...base, kind: "folder" };
      if (r.kind === "text") return { ...base, kind: "text", data: Buffer.from(r.text ?? "", "utf8") };
      return { ...base, kind: "file", size: r.size, crc32: r.crc32!, file: ctx.blobs.path(r.blob!) };
    });
    const layout = zipLayout(entries);
    const etag = hash(JSON.stringify(rows.map((r) => [r.id, r.path, r.kind, r.blob, r.size, r.created])));
    const name = folder?.name ?? ctx.library.summaries([itemId]).get(itemId)!.name;
    reply.type("application/zip").header("Content-Disposition", contentDisposition("attachment", `${name}.zip`));
    return send(req, reply, { ...layout, etag });
  }

  // GET and HEAD share a handler: the automatic HEAD route would replace Content-Length with 0.
  const stream = (url: string, handler: (req: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => unknown) =>
    app.route<{ Params: Params }>({ method: ["GET", "HEAD"], url, handler });

  stream("/api/nodes/:id/content", (req, reply) => content(req, reply, ownedNode(req, req.params.id)));
  stream("/api/nodes/:id/thumbnail", (req, reply) => thumbnail(req, reply, ownedNode(req, req.params.id)));
  stream("/api/items/:id/zip", (req, reply) => {
    ctx.library.owned(requireMember(ctx, req).userId, req.params.id);
    return zip(req, reply, req.params.id);
  });
  // Every share route asks the link first: its password, and who it lets in.
  stream("/api/s/:token/nodes/:node/content", (req, reply) => {
    const access = ctx.links.content(req.params.token, req);
    const node = sharedNode(access, req.params.node);
    counted(req, access, (req.query as Query).inline !== "1" && node.kind !== "folder");
    return content(req, reply, node);
  });
  stream("/api/s/:token/nodes/:node/thumbnail", (req, reply) => {
    const access = ctx.links.content(req.params.token, req);
    return thumbnail(req, reply, sharedNode(access, req.params.node));
  });
  stream("/api/s/:token/zip", (req, reply) => {
    const access = ctx.links.content(req.params.token, req);
    counted(req, access, true);
    return zip(req, reply, access.itemId);
  });
}
