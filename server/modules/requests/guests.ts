import type { FastifyInstance } from "fastify";
import { principalKey, type Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import { LIMITS, type PublicRequest } from "../../../shared/model.ts";
import { cookieOptions, grantFor, guestCookie } from "../../lib/auth.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { cleanLabel } from "../../lib/names.ts";
import { cleanFileName } from "../../../shared/text.ts";
import { route } from "../../lib/http.ts";
import { randomToken, sha256 } from "../../lib/secrets.ts";
import { addressKey, perAddress } from "../auth/limits.ts";
import { codeNetworkOf } from "../../lib/pickup-code-guard.ts";
import { autoName } from "../library/summary.ts";
import { ensureTransferAvailability } from "../transfers/availability.ts";
import { visitorStorageRoom } from "../transfers/room.ts";

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
  const now = Date.now();
  return ctx.db.get<{ entries: number; bytes: number; activeBytes: number; trashBytes: number; pendingBytes: number }>(
    `SELECT COUNT(n.id) AS entries, ifnull(SUM(n.size), 0) AS bytes,
       ifnull(SUM(CASE WHEN n.state = 'ready' AND i.trashed IS NULL AND (i.expires IS NULL OR i.expires > ?) THEN n.size ELSE 0 END), 0) AS activeBytes,
       ifnull(SUM(CASE WHEN n.state = 'ready' AND (i.trashed IS NOT NULL OR i.expires <= ?) THEN n.size ELSE 0 END), 0) AS trashBytes,
       ifnull(SUM(CASE WHEN n.state = 'pending' THEN n.size ELSE 0 END), 0) AS pendingBytes
     FROM items i JOIN nodes n ON n.item = i.id WHERE i.request_id = ?`,
    now,
    now,
    requestId,
  )!;
}

/**
 * What the request can still accept, for its visitors: its size limit, and the fixed entry guard
 * against empty-file floods. Read from the totals the request_held_* triggers keep (schema.sql), so
 * a visitor's page view or send costs the same however many files the request holds.
 */
export function room(ctx: Context, request: Pick<OpenRow, "id" | "max_bytes">) {
  const held = ctx.db.get<{ entries: number; bytes: number }>(
    "SELECT held_entries AS entries, held_bytes AS bytes FROM requests WHERE id = ?",
    request.id,
  ) ?? { entries: 0, bytes: 0 };
  return {
    bytes: Math.max(0, request.max_bytes - held.bytes),
    entries: Math.max(0, LIMITS.requestEntries - held.entries),
  };
}

/** What the request can still accept, with how its bytes divide, for the owner's list. */
export function remaining(ctx: Context, request: Pick<OpenRow, "id" | "max_bytes">) {
  const held = used(ctx, request.id);
  return {
    bytes: Math.max(0, request.max_bytes - held.bytes),
    entries: Math.max(0, LIMITS.requestEntries - held.entries),
    held: held.bytes,
    activeBytes: held.activeBytes,
    trashBytes: held.trashBytes,
    pendingBytes: held.pendingBytes,
  };
}

/**
 * "Tax papers · Dana", or without a name "Tax papers · W-2.pdf + 2 more" (or "+ text", or
 * "Text · 120 characters"), so several guests' submissions are told apart. Bounded to the item name
 * limit, keeping the request's name first.
 */
function submissionName(
  request: string,
  sender: string | null,
  text: string | undefined,
  plan: { name: string; parentKey: string | null }[],
) {
  const top = plan.filter((node) => node.parentKey === null);
  const chars = text?.trim() ? [...text].length : null;
  const label = sender ?? autoName(top[0]?.name ?? null, top.length, chars) ?? "submission";
  // The guest and the owner chose these words freely, so make them a valid item name (`cleanName`)
  // rather than refuse the files: no slashes, control or direction marks or hidden characters,
  // within the name limit and a file name's 255 bytes.
  const name = [
    ...cleanFileName(cleanLabel(`${request} · ${label}`, Number.MAX_SAFE_INTEGER)!)
      .replace(/[/\\]/g, "-")
      // A lone half of a surrogate pair isn't a character a name can hold.
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD"),
  ];
  const fits = () => {
    const joined = name.join("");
    return joined.length <= LIMITS.nameLength && Buffer.byteLength(joined) <= 255;
  };
  while (!fits()) name.pop();
  return name.join("").trim();
}

/**
 * Visits (grants) one address and one network may keep to one request. Each lasts as long as the
 * request, so without a limit every cookie-less `/start` would add a row for up to a year.
 */
export const VISITS_PER_ADDRESS = 16;
export const VISITS_PER_NETWORK = 64;

/**
 * Makes room for one more visit from `address` by forgetting an idle one: a visit with no send
 * open, which a visitor's page needs only to send. It forgets the address's own oldest first, so
 * one device starting visits over and over cycles through its own and leaves its neighbours' be;
 * only a network full of several addresses' visits gives up its oldest. A network may keep only 10
 * sends open, far fewer than either limit, so there is always an idle visit, and a visitor whose
 * visit was forgotten is given a new one when they next send, as their page asks before each send.
 */
function makeRoomForVisit(ctx: Context, requestId: string, network: string, address: string) {
  const count = (sql: string, limit: number, ...args: string[]) =>
    ctx.db.value<number>(`SELECT count(*) FROM (SELECT 1 FROM guest_grants WHERE ${sql} LIMIT ?)`, ...args, limit)!;
  const ownFull =
    count("request_id = ? AND network = ? AND address = ?", VISITS_PER_ADDRESS, requestId, network, address) >=
    VISITS_PER_ADDRESS;
  if (!ownFull && count("request_id = ? AND network = ?", VISITS_PER_NETWORK, requestId, network) < VISITS_PER_NETWORK)
    return;
  const idle = ctx.db.value<string>(
    `SELECT g.token_hash FROM guest_grants g
     WHERE g.request_id = ? AND g.network = ? AND (? = 0 OR g.address = ?)
       AND NOT EXISTS (SELECT 1 FROM transfers t WHERE t.principal = 'grant:' || g.token_hash AND t.state = 'open')
     ORDER BY g.address = ? DESC, g.created LIMIT 1`,
    requestId,
    network,
    ownFull ? 1 : 0,
    address,
    address,
  );
  if (idle === undefined)
    fail(429, "Too many people on your network are sending to this request. Try again in a few minutes.");
  ctx.db.run("DELETE FROM guest_grants WHERE token_hash = ?", idle);
}

export function registerGuests(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.requests.open, ({ params }): PublicRequest => {
    const request = openRequest(ctx, params.token);
    const left = room(ctx, request);
    // The request's own room is only part of it: the server and the owner's storage must take the
    // bytes too, or a visitor is told there is room and then refused at the first byte.
    const storage = visitorStorageRoom(ctx, request.owner);
    const bytes = Math.min(left.bytes, storage);
    return {
      name: request.name,
      description: request.description,
      expires: request.expires,
      owner: request.owner_name,
      maxBytes: request.max_bytes,
      remainingBytes: bytes,
      full: bytes === 0 || left.entries === 0,
      storageLimited: storage < left.bytes,
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
      const address = addressKey(req.ip);
      const network = codeNetworkOf(req.ip);
      ctx.db.tx(() => {
        makeRoomForVisit(ctx, request.id, network, address);
        ctx.db.run(
          `INSERT INTO guest_grants(token_hash, request_id, csrf, created, expires, address, network)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
          sha256(token),
          request.id,
          csrf,
          Date.now(),
          request.expires,
          address,
          network,
        );
      });
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
      const sender = cleanLabel(typed, LIMITS.senderLength);
      const principal = principalKey(grant);
      const target =
        ctx.db.value<string>("SELECT item FROM transfers WHERE id = ? AND principal = ?", input.id, principal) ??
        grant.itemId;
      ensureTransferAvailability(ctx, { owner: request.owner, principal, ...(target ? { item: target } : {}) });
      const created = ctx.transfers.create(
        { ...input, name: null },
        {
          owner: request.owner,
          principal: grant,
          requestId: request.id,
          // Worked out from the plan the create makes anyway, so a long list is planned once.
          itemName: (plan) => submissionName(request.name, sender, input.text, plan),
          sender,
          limit: room(ctx, request),
        },
      );
      ctx.events.publish(request.owner, "requests");
      return created;
    },
    {
      bodyLimit: LIMITS.manifestBytes,
      // Only this request's guests may send a manifest, checked before Relay reads one.
      admit: (req) => {
        const request = openRequest(ctx, (req.params as { token: string }).token);
        if (!grantFor(ctx, req, request.id)) fail(401, "Open the request link again to continue.");
      },
    },
  );
}
