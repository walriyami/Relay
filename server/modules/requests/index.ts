// Upload requests: an owner publishes a bounded intake link; guests add files to it and can never
// read anything back.
import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import type { Submission, UploadRequest } from "../../../shared/model.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { sha256 } from "../../lib/secrets.ts";
import { getPickupCode, issueUrlPickupCode } from "../../lib/pickup-codes.ts";
import { bytesLabel } from "../transfers/create.ts";
import { allowedLinkDays } from "../auth/member-limits.ts";
import { registerGuests, remaining, used } from "./guests.ts";

const DAY_MS = 86_400_000;

type RequestRow = {
  id: string;
  name: string;
  description: string;
  created: number;
  expires: number;
  closed: number | null;
  max_bytes: number;
  last_received: number | null;
  received_files: number;
  received_bytes: number;
};
/** Received counts are the request's saved files, across all of its submission items. */
const SELECT = `SELECT r.id, r.name, r.description, r.created, r.expires, r.closed, r.max_bytes,
    r.last_received, COUNT(n.id) AS received_files, ifnull(SUM(n.size), 0) AS received_bytes
  FROM requests r
  LEFT JOIN items i ON i.request_id = r.id
  LEFT JOIN nodes n ON n.item = i.id AND n.kind = 'file' AND n.state = 'ready'`;

function toRequest(ctx: Context, row: RequestRow): UploadRequest {
  const left = remaining(ctx, row);
  const code = getPickupCode(ctx.db, ctx.secrets, "request", row.id) ?? "";
  return {
    id: row.id,
    token: ctx.secrets.requestToken(row.id),
    code,
    name: row.name,
    description: row.description,
    created: row.created,
    expires: row.expires,
    closed: row.closed !== null,
    maxBytes: row.max_bytes,
    receivedFiles: row.received_files,
    receivedBytes: row.received_bytes,
    usedBytes: left.held,
    activeBytes: left.activeBytes,
    trashBytes: left.trashBytes,
    pendingBytes: left.pendingBytes,
    full: left.bytes === 0 || left.entries === 0,
    lastReceived: row.last_received,
  };
}

const ownedRequest = (ctx: Context, owner: string, id: string) =>
  ctx.db.get<RequestRow>(`${SELECT} WHERE r.id = ? AND r.owner = ? GROUP BY r.id`, id, owner) ??
  notFound("That request");

export function registerRequests(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.requests.list, ({ member }) =>
    ctx.db
      .all<RequestRow>(`${SELECT} WHERE r.owner = ? GROUP BY r.id ORDER BY r.created DESC`, member.userId)
      .map((row) => toRequest(ctx, row)),
  );

  route(app, ctx, api.requests.create, ({ member, body }) => {
    // Save the original choices, not their clamped or later edited values, for retry identity.
    const fingerprint = sha256(JSON.stringify([body.name, body.description, body.days, body.maxBytes]));
    const created = ctx.db.tx(() => {
      const existing = ctx.db.get<{ owner: string; creation_fingerprint: string }>(
        "SELECT owner, creation_fingerprint FROM requests WHERE id = ?",
        body.id,
      );
      if (existing && (existing.owner !== member.userId || existing.creation_fingerprint !== fingerprint))
        fail(409, "That request id is already in use.");
      if (!existing) {
        // Request tokens and pickup codes are derived from the id, and registry history is kept
        // after a request's row is removed. Do not let a caller reuse an old recipient id.
        if (ctx.db.get("SELECT 1 FROM pickup_codes WHERE kind = 'request' AND target_id = ?", body.id))
          fail(409, "That request id has already been used.");
        const now = Date.now();
        const pickup = issueUrlPickupCode(ctx.db, ctx.secrets, "request", body.id);
        ctx.db.run(
          `INSERT INTO requests(id, owner, token_hash, name, description, created, expires, max_bytes, code_hash, creation_fingerprint)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          body.id,
          member.userId,
          sha256(ctx.secrets.requestToken(body.id)),
          body.name,
          body.description,
          now,
          now + allowedLinkDays(ctx, member.userId, body.days)! * DAY_MS,
          body.maxBytes,
          pickup.codeHash,
          fingerprint,
        );
      }
      return ownedRequest(ctx, member.userId, body.id);
    });
    ctx.events.publish(member.userId, "requests");
    return toRequest(ctx, created);
  });

  route(app, ctx, api.requests.update, ({ member, params, body }) => {
    const updated = ctx.db.tx(() => {
      const request = ownedRequest(ctx, member.userId, params.id);
      if (request.closed !== null) fail(410, "This request was closed. Create a new request instead.");
      const now = Date.now();
      if (request.expires <= now) fail(410, "This request has expired. Create a new request instead.");
      const expires =
        body.days === null ? request.expires : now + allowedLinkDays(ctx, member.userId, body.days)! * DAY_MS;
      const held = used(ctx, request.id).bytes;
      if (body.maxBytes < held)
        fail(409, `This request already holds ${bytesLabel(held)}. Choose a size limit of at least that.`);
      ctx.db.run(
        "UPDATE requests SET name = ?, description = ?, expires = ?, max_bytes = ? WHERE id = ?",
        body.name,
        body.description,
        expires,
        body.maxBytes,
        request.id,
      );
      // Guests already uploading keep going for exactly as long as the request now stays open.
      ctx.db.run("UPDATE guest_grants SET expires = ? WHERE request_id = ?", expires, request.id);
      // An open request can recover a missing assignment without changing its public URL.
      if (!getPickupCode(ctx.db, ctx.secrets, "request", request.id)) {
        const issued = issueUrlPickupCode(ctx.db, ctx.secrets, "request", request.id);
        ctx.db.run("UPDATE requests SET code_hash = ? WHERE id = ?", issued.codeHash, request.id);
      }
      return ownedRequest(ctx, member.userId, request.id);
    });
    ctx.events.publish(member.userId, "requests");
    return toRequest(ctx, updated);
  });

  route(app, ctx, api.requests.submissions, ({ member, params }): Submission[] => {
    ownedRequest(ctx, member.userId, params.id);
    const rows = ctx.db.all<{ id: string; sender: string | null }>(
      `SELECT id, sender FROM items WHERE request_id = ? AND owner = ? AND trashed IS NULL AND (expires IS NULL OR expires > ?)
       ORDER BY created DESC`,
      params.id,
      member.userId,
      Date.now(),
    );
    const summaries = ctx.library.summaries(rows.map((row) => row.id));
    return rows.flatMap((row) => {
      const summary = summaries.get(row.id);
      return summary ? [{ ...summary, sender: row.sender }] : [];
    });
  });

  route(app, ctx, api.requests.close, ({ member, params }) => {
    const request = ownedRequest(ctx, member.userId, params.id);
    // Closing first makes every guest grant invalid at once; cancelling then removes their unfinished files.
    ctx.db.run("UPDATE requests SET closed = ? WHERE id = ? AND closed IS NULL", Date.now(), request.id);
    ctx.transfers.cancelForRequest(request.id);
    ctx.events.publish(member.userId, "requests", "items");
    return { ok: true as const };
  });

  registerGuests(app, ctx);
}
