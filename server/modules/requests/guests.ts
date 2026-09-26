import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import { LIMITS, type PublicRequest } from "../../../shared/model.ts";
import { cookieOptions, grantFor, guestCookie } from "../../lib/auth.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { randomToken, sha256 } from "../../lib/secrets.ts";
import { perAddress } from "../auth/limits.ts";
import { autoName } from "../library/summary.ts";
import { planNodes } from "../transfers/plan.ts";

type OpenRow = {
  id: string;
  owner: string;
  owner_name: string;
  name: string;
  description: string;
  expires: number;
  max_bytes: number;
};

/** The request behind a public token, while guests may still add to it. */
function openRequest(ctx: Context, token: string): OpenRow {
  type Row = OpenRow & { closed: number | null; owner_disabled: number };
  const row =
    ctx.db.get<Row>(
      `SELECT r.id, r.owner, coalesce(u.display_name, u.username) AS owner_name, r.name, r.description, r.expires, r.closed, r.max_bytes,
         u.disabled AS owner_disabled
       FROM requests r JOIN users u ON u.id = r.owner WHERE r.token_hash = ?`,
      sha256(token),
    ) ?? notFound("That request");
  if (row.closed !== null || row.expires <= Date.now() || row.owner_disabled) fail(410, "This request is closed.");
  return row;
}

/** Bytes and entries a request holds, unfinished uploads included so concurrent guests cannot overshoot. */
export function used(ctx: Context, requestId: string) {
  return ctx.db.get<{ entries: number; bytes: number }>(
    `SELECT COUNT(n.id) AS entries, ifnull(SUM(n.size), 0) AS bytes
     FROM items i JOIN nodes n ON n.item = i.id WHERE i.request_id = ?`,
    requestId,
  )!;
}

/** What the request can still accept: its size limit, and the fixed entry guard against empty-file floods. */
export function remaining(ctx: Context, request: Pick<OpenRow, "id" | "max_bytes">) {
  const held = used(ctx, request.id);
  return {
    bytes: Math.max(0, request.max_bytes - held.bytes),
    entries: Math.max(0, LIMITS.requestEntries - held.entries),
    held: held.bytes,
  };
}

/** A guest's name as a label: one line, no control or direction characters; null when blank. */
function cleanSender(value: string | undefined): string | null {
  const name = (value ?? "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- control characters are exactly what's replaced.
    .replace(/[\x00-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name ? [...name].slice(0, LIMITS.senderLength).join("") : null;
}

/**
 * "Tax papers · Dana", or without a name "Tax papers · W-2.pdf + 2 more", so several guests'
 * submissions are told apart. Bounded to the item name limit, keeping the request's name first.
 */
function submissionName(request: string, sender: string | null, input: Parameters<typeof planNodes>[0]) {
  const top = planNodes(input).filter((node) => node.parentKey === null);
  const label = sender ?? autoName(top[0]?.name ?? null, top.length, null) ?? "submission";
  return [...`${request} · ${label}`].slice(0, LIMITS.nameLength).join("");
}

export function registerGuests(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.requests.open, ({ params }): PublicRequest => {
    const request = openRequest(ctx, params.token);
    const left = remaining(ctx, request);
    return {
      name: request.name,
      description: request.description,
      expires: request.expires,
      owner: request.owner_name,
      maxBytes: request.max_bytes,
      remainingBytes: left.bytes,
      full: left.bytes === 0 || left.entries === 0,
    };
  });

  route(
    app,
    ctx,
    api.requests.start,
    ({ params, req, reply }) => {
      const request = openRequest(ctx, params.token);
      const cookie = guestCookie(ctx, req, request.id);
      // A browser session can outlast the original deadline when the owner extends the request.
      // The current request and grant expiry in the database still authorize every operation.
      const options = { ...cookieOptions(ctx, req, 1), maxAge: undefined };
      const held = grantFor(ctx, req, request.id);
      if (held) {
        reply.setCookie(cookie, req.cookies[cookie]!, options);
        return { csrf: held.csrf };
      }
      const token = randomToken();
      const csrf = randomToken();
      ctx.db.run(
        "INSERT INTO guest_grants(token_hash, request_id, csrf, created, expires) VALUES(?, ?, ?, ?, ?)",
        sha256(token),
        request.id,
        csrf,
        Date.now(),
        request.expires,
      );
      reply.setCookie(cookie, token, options);
      return { csrf };
    },
    { rateLimit: perAddress(20, "1 minute") },
  );

  route(
    app,
    ctx,
    api.requests.transfer,
    ({ params, req, body }) => {
      const request = openRequest(ctx, params.token);
      const grant = grantFor(ctx, req, request.id) ?? fail(401, "Open the request link again to continue.");
      // One synchronous block: the limits read here are the ones the new uploads are admitted against.
      // Each new transfer gets an independent item; retries resolve their original item by transfer ID.
      const { sender: typed, ...input } = body;
      const sender = cleanSender(typed);
      const created = ctx.db.tx(() => {
        const left = remaining(ctx, request);
        const result = ctx.transfers.create(
          { ...input, name: null },
          {
            owner: request.owner,
            principal: grant,
            requestId: request.id,
            itemName: submissionName(request.name, sender, input),
            limit: left,
          },
        );
        if (sender !== null)
          ctx.db.run("UPDATE items SET sender = coalesce(sender, ?) WHERE id = ?", sender, result.itemId);
        return result;
      });
      ctx.events.publish(request.owner, "requests");
      return created;
    },
    { bodyLimit: LIMITS.manifestBytes },
  );
}
