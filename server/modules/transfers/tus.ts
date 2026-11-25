// tus 1.0 core (OPTIONS, HEAD, PATCH) on /uploads/:id. Uploads are created by transfers.create,
// so no tus extensions are offered. Only the transfer's own principal can see an upload.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ensureTransferAvailability, settleTransferAvailability } from "./availability.ts";
import { headers } from "../../../shared/api.ts";
import { LIMITS } from "../../../shared/model.ts";
import type { Context } from "../../context.ts";
import type { Auth } from "../../context.ts";
import { currentAuth, currentPrincipalFor } from "../../lib/auth.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { CANCELLED, MOVED, TAB_CLOSED } from "./create.ts";
import { uploadRow, type Receivers } from "./receivers.ts";
import { ensureVisitorRoom } from "./room.ts";

const TUS_VERSION = "1.0.0";
const TUS_TYPE = "application/offset+octet-stream";

/** The member or guest grant among `auth`'s credentials that owns `key`. */
const principalIn = (auth: Auth, key: string) =>
  auth.member && key === `user:${auth.member.userId}`
    ? auth.member
    : (auth.grants.find((g) => key === `grant:${g.tokenHash}`) ?? null);

/**
 * A PATCH refused part-way leaves the rest of its chunk unread. Reading and dropping it lets the
 * answer reach the client (and a proxy) instead of a cut connection; past one chunk's worth, or a
 * client that stalls, the connection is closed after all.
 */
function drain(req: FastifyRequest) {
  const body = req.raw;
  if (body.complete || body.destroyed) return;
  let left = LIMITS.chunkBytes;
  const timer = setTimeout(() => body.destroy(), 30_000).unref();
  body.on("data", (chunk: Buffer) => {
    left -= chunk.length;
    if (left < 0) body.destroy();
  });
  body.once("close", () => clearTimeout(timer));
  body.resume();
}

export function registerTus(app: FastifyInstance, ctx: Context, receivers: Receivers) {
  // Leave the body unread: PATCH streams it straight to disk.
  app.addContentTypeParser(TUS_TYPE, (_req, _payload, done) => done(null));

  const tus = (reply: FastifyReply) => reply.header("Tus-Resumable", TUS_VERSION).header("Cache-Control", "no-store");

  /**
   * The caller's upload; 410 once it stopped accepting data, 409 when its tab was closed. An upload
   * abandoned with its tab may be gone entirely, so the caller's own tab header is consulted too.
   */
  const access = (req: FastifyRequest) => {
    const upload = uploadRow(ctx, (req.params as { id: string }).id);
    if (upload) settleTransferAvailability(ctx, upload);
    const auth = currentAuth(ctx, req);
    if (!auth.member && !auth.grants.length) fail(401, "Sign in to continue.");
    const principal = upload ? principalIn(auth, upload.principal) : null;
    if (!upload || !principal) {
      const tab = req.headers[headers.tab.toLowerCase()];
      const row =
        typeof tab === "string"
          ? ctx.db.get<{ principal: string }>("SELECT principal FROM tabs WHERE id = ? AND closed IS NOT NULL", tab)
          : undefined;
      if (row && currentPrincipalFor(ctx, req, row.principal)) fail(409, TAB_CLOSED);
      return notFound("That upload");
    }
    ensureTransferAvailability(ctx, upload);
    // A page that names itself must still be the one sending: another may have continued the upload.
    const tab = req.headers[headers.tab.toLowerCase()];
    if (typeof tab === "string" && tab !== upload.tab && upload.state === "open") fail(409, MOVED);
    if (!ctx.transfers.renewTab(upload.tab, principal)) fail(409, TAB_CLOSED);
    if (upload.state !== "open" && upload.state !== "complete") fail(410, CANCELLED);
    if (upload.completed === null && upload.node === null) fail(410, "This file was removed from its transfer.");
    return upload;
  };

  const recheck = (req: FastifyRequest, principal: string) => () => {
    if (!currentPrincipalFor(ctx, req, principal)) fail(401, "Sign in to continue.");
  };

  app.route({
    method: "OPTIONS",
    url: "/uploads/:id",
    handler: (_req, reply) => tus(reply).header("Tus-Version", TUS_VERSION).code(204).send(),
  });

  app.route({
    method: "HEAD",
    url: "/uploads/:id",
    handler: async (req, reply) => {
      tus(reply);
      let upload = access(req);
      await receivers.settle(upload.id, recheck(req, upload.principal));
      upload = access(req);
      return reply
        .header("Upload-Offset", String(upload.completed === null ? upload.offset : upload.size))
        .header("Upload-Length", String(upload.size))
        .code(200)
        .send();
    },
  });

  app.route({
    method: "PATCH",
    url: "/uploads/:id",
    handler: async (req, reply) => {
      tus(reply);
      if (req.headers["tus-resumable"] !== TUS_VERSION) {
        reply.header("Tus-Version", TUS_VERSION);
        fail(412, "This server speaks tus 1.0.0.");
      }
      if (req.headers["content-type"]?.split(";")[0].trim() !== TUS_TYPE)
        fail(415, `Upload chunks must be sent as ${TUS_TYPE}.`);
      const header = req.headers["upload-offset"];
      if (typeof header !== "string" || !/^\d+$/.test(header)) fail(400, "Upload-Offset is required.");
      const offset = Number(header);
      let upload = access(req);
      await receivers.settle(upload.id, recheck(req, upload.principal));
      upload = access(req);
      const length = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"]);
      if (length !== null && length > LIMITS.chunkBytes) fail(413, "This request carries more than one chunk of data.");
      reply.header("Upload-Length", String(upload.size));
      const conflict = (current: number) =>
        reply
          .code(409)
          .header("Upload-Offset", String(current))
          .send({ error: "The upload is at a different offset." });
      if (upload.completed !== null)
        return offset === upload.size && !length
          ? reply.code(204).header("Upload-Offset", String(upload.size)).send()
          : conflict(upload.size);
      if (length !== null && offset + length > upload.size)
        fail(413, "This request carries more bytes than the file's size.");
      const visitor = upload.principal.startsWith("grant:");
      const guard = visitor ? () => ensureVisitorRoom(ctx, uploadRow(ctx, upload.id) ?? upload) : undefined;
      let received;
      try {
        received = await receivers.receive(
          upload.id,
          offset,
          req.raw,
          () => req.raw.destroy(),
          recheck(req, upload.principal),
          guard,
        );
      } catch (error) {
        drain(req);
        throw error;
      }
      if ("conflict" in received) return conflict(received.conflict);
      return reply.code(204).header("Upload-Offset", String(received.offset)).send();
    },
  });
}
