import type { FastifyReply, FastifyRequest } from "fastify";
import type { Context, LinkInput, Links, ShareAccess } from "../../context.ts";
import { LINK_USED_UP, type Link, type LinkVisit } from "../../../shared/model.ts";
import { deviceLabel } from "../../../shared/devices.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { authOf, cookieOptions, visitorCookie } from "../../lib/auth.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { randomToken, sha256, verifyPassword } from "../../lib/secrets.ts";
import { FailureLog } from "../auth/limits.ts";
import { allowedLinkDays } from "../auth/member-limits.ts";
import { getPickupCode, issuePickupCode } from "../../lib/pickup-codes.ts";
import { DAY_MS } from "../../lib/time.ts";

/** A browser keeps its visitor cookie this long; it only tells one person from another. */
const VISITOR_MS = 365 * DAY_MS;
/** Repeated requests from one visitor (thumbnails, previews) move `last` at most this often. */
const TOUCH_MS = 60_000;

export const LOCKED = "Enter this link’s password to open it.";

export type LinkRow = {
  id: string;
  owner: string;
  item: string;
  created: number;
  expires: number | null;
  revoked: number | null;
  password_hash: string | null;
  visitor_limit: number | null;
  note: string;
  /** The item is neither trashed nor expired. */
  item_live: number;
  owner_disabled: number;
  visitors: number;
  downloads: number;
  last_visit: number | null;
};
/** Select from `links l JOIN items i JOIN users u`; `?` is the current time. */
export const LINK_SELECT = `SELECT l.id, l.owner, l.item, l.created, l.expires, l.revoked, l.password_hash,
    l.visitor_limit, l.note, u.disabled AS owner_disabled,
    (i.trashed IS NULL AND (i.expires IS NULL OR i.expires > ?)) AS item_live,
    (SELECT count(*) FROM link_visits v WHERE v.link = l.id) AS visitors,
    (SELECT coalesce(sum(downloads), 0) FROM link_visits v WHERE v.link = l.id) AS downloads,
    (SELECT max(last) FROM link_visits v WHERE v.link = l.id) AS last_visit
  FROM links l JOIN items i ON i.id = l.item JOIN users u ON u.id = l.owner`;

/** SQL for "this link has not expired"; `?` is the current time. */
export const LINK_UNEXPIRED = "(l.expires IS NULL OR l.expires > ?)";

const expired = (row: Pick<LinkRow, "expires">, now: number) => row.expires !== null && row.expires <= now;
const usedUp = (row: Pick<LinkRow, "visitor_limit" | "visitors">) =>
  row.visitor_limit !== null && row.visitors >= row.visitor_limit;

export const isAvailable = (row: LinkRow, now: number) => !row.revoked && !expired(row, now) && !!row.item_live;

/** Unknown, revoked, expired or disabled-owner links are 404; a valid link to removed content is 410. */
export function checkAvailable(row: LinkRow | undefined, now: number): LinkRow {
  if (!row || row.owner_disabled) return notFound("This link");
  if (!row.item_live) fail(410, "The content of this link is no longer available.");
  if (row.revoked || expired(row, now)) notFound("This link");
  return row;
}

export function toLinks(ctx: Context, rows: LinkRow[], now = Date.now()): Link[] {
  const summaries = ctx.library.summaries([...new Set(rows.map((r) => r.item))]);
  return rows.map((row) => ({
    id: row.id,
    itemId: row.item,
    token: ctx.secrets.linkToken(row.id),
    code: getPickupCode(ctx.db, ctx.secrets, "share", row.id) ?? "",
    created: row.created,
    expires: effectiveLinkExpiry(row.expires, summaries.get(row.item)?.expires ?? null),
    revoked: !!row.revoked,
    available: isAvailable(row, now),
    full: usedUp(row),
    locked: row.password_hash !== null,
    visitorLimit: row.visitor_limit,
    note: row.note,
    visitors: row.visitors,
    downloads: row.downloads,
    lastVisit: row.last_visit,
    item: summaries.get(row.item) ?? null,
  }));
}

export function ownedLink(ctx: Context, owner: string, id: string, now = Date.now()): LinkRow {
  return ctx.db.get<LinkRow>(`${LINK_SELECT} WHERE l.id = ? AND l.owner = ?`, now, id, owner) ?? notFound("That link");
}

export const linkExpiry = (days: number | null, now: number) => (days === null ? null : now + days * DAY_MS);

/** A share cannot promise availability beyond its content's current lifetime. */
export const effectiveLinkExpiry = (expires: number | null, itemExpires: number | null) =>
  expires === null ? itemExpires : itemExpires === null ? expires : Math.min(expires, itemExpires);

export function linkVisits(ctx: Context, owner: string, id: string): LinkVisit[] {
  ownedLink(ctx, owner, id);
  return ctx.db.all<LinkVisit>(
    "SELECT id, device, first, last, downloads FROM link_visits WHERE link = ? ORDER BY last DESC, id DESC LIMIT 200",
    id,
  );
}

type VisitRow = { id: string; unlocked: string | null; last: number };

/** Wrong passwords per link within the window: enough for typos, too few to guess. */
const UNLOCK_FAILURES = { max: 10, windowMs: 15 * 60_000 };

/**
 * Who is asking for a link's content: "owner" for its owner, signed in, who is never counted or
 * locked out. Anyone else is told apart by a random cookie, and their visit is keyed by an HMAC of
 * it and the link id. Without a reply to set a new cookie on, a browser that has none is anonymous.
 */
function visitorOf(ctx: Context, req: FastifyRequest, reply: FastifyReply | null, row: LinkRow) {
  if (authOf(ctx, req).member?.userId === row.owner) return "owner" as const;
  const name = visitorCookie(ctx, req);
  let secret = req.cookies[name];
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    if (!reply) return null;
    secret = randomToken();
  }
  // Refreshed on every open, so a browser that keeps coming back stays the same person.
  reply?.setCookie(name, secret, cookieOptions(ctx, req, VISITOR_MS));
  return sha256(`${secret}:${row.id}`);
}

const visitOf = (ctx: Context, linkId: string, visitor: string) =>
  ctx.db.get<VisitRow>("SELECT id, unlocked, last FROM link_visits WHERE link = ? AND visitor = ?", linkId, visitor);

/**
 * Lets a visitor in: records them the first time (which counts toward a limit, and tells the owner),
 * and afterwards notes when they were last here. `unlocked` is the password hash they just entered.
 */
function admit(ctx: Context, req: FastifyRequest, row: LinkRow, visitor: string, unlocked: string | null) {
  const now = Date.now();
  return ctx.db.tx(() => {
    const visit = visitOf(ctx, row.id, visitor);
    if (visit) {
      if (unlocked !== null && visit.unlocked !== unlocked)
        ctx.db.run("UPDATE link_visits SET unlocked = ?, last = ? WHERE id = ?", unlocked, now, visit.id);
      else if (now - visit.last >= TOUCH_MS) ctx.db.run("UPDATE link_visits SET last = ? WHERE id = ?", now, visit.id);
      return visit.id;
    }
    const current = ctx.db.value<number>("SELECT count(*) FROM link_visits WHERE link = ?", row.id)!;
    if (row.visitor_limit !== null && current >= row.visitor_limit) fail(410, LINK_USED_UP);
    const id = uuidv7();
    const device = deviceLabel(String(req.headers["user-agent"] ?? ""));
    ctx.db.run(
      "INSERT INTO link_visits(id, link, visitor, device, first, last, unlocked) VALUES(?, ?, ?, ?, ?, ?, ?)",
      id,
      row.id,
      visitor,
      device,
      now,
      now,
      unlocked,
    );
    ctx.activity.record(row.owner, {
      kind: "link",
      linkId: row.id,
      itemId: row.item,
      item: ctx.library.summaries([row.item]).get(row.item)?.name ?? "",
      action: "opened",
      device,
    });
    ctx.usage.add(row.owner, { visitors: 1 });
    ctx.events.publish(row.owner, "links");
    return id;
  });
}

/**
 * The token and pickup code are HMACs of the link id, so the owner can always be shown them again,
 * while the database stores only their hashes.
 */
export function createLinks(ctx: Context): Links {
  const find = (token: string, now = Date.now()) =>
    checkAvailable(ctx.db.get<LinkRow>(`${LINK_SELECT} WHERE l.token_hash = ?`, now, sha256(token)), now);
  const granted = (row: LinkRow, visit: string | null, locked = false): ShareAccess => ({
    linkId: row.id,
    itemId: row.item,
    owner: row.owner,
    note: row.note,
    expires: row.expires,
    visit,
    byOwner: false,
    locked,
  });
  const ownerAccess = (row: LinkRow): ShareAccess => ({ ...granted(row, null), byOwner: true });
  const failures = new FailureLog(UNLOCK_FAILURES.windowMs);

  function open(token: string, req: FastifyRequest, reply: FastifyReply): ShareAccess {
    const row = find(token);
    const visitor = visitorOf(ctx, req, reply, row);
    if (visitor === "owner") return ownerAccess(row);
    // A new cookie can always be set here, so there is a visitor.
    const visit = visitOf(ctx, row.id, visitor!);
    if (row.password_hash !== null && visit?.unlocked !== row.password_hash) {
      // Nobody new gets as far as the password once the link is used up.
      if (!visit && usedUp(row)) fail(410, LINK_USED_UP);
      return granted(row, null, true);
    }
    return granted(row, admit(ctx, req, row, visitor!, null));
  }

  return {
    open,

    content(token, req) {
      const row = find(token);
      const visitor = visitorOf(ctx, req, null, row);
      if (visitor === "owner") return ownerAccess(row);
      const visit = visitor === null ? undefined : visitOf(ctx, row.id, visitor);
      if (row.password_hash !== null && visit?.unlocked !== row.password_hash) fail(401, LOCKED);
      if (visit) return granted(row, admit(ctx, req, row, visitor!, null));
      // Someone the link hasn't let in yet. A limited link only serves the people it counted; an
      // open one serves anyone, counting them when their browser can be told apart.
      if (row.visitor_limit !== null)
        fail(usedUp(row) ? 410 : 401, usedUp(row) ? LINK_USED_UP : "Open the link first.");
      return granted(row, visitor === null ? null : admit(ctx, req, row, visitor, null));
    },

    async unlock(token, password, req, reply) {
      const row = find(token);
      const visitor = visitorOf(ctx, req, reply, row);
      if (visitor === "owner" || row.password_hash === null) return open(token, req, reply);
      const now = Date.now();
      if (!failures.reserve(row.id, now, UNLOCK_FAILURES.max))
        fail(429, "Too many wrong passwords. Wait a few minutes and try again.");
      try {
        if (!(await verifyPassword(password, row.password_hash))) {
          failures.add(row.id, Date.now());
          fail(403, "That password isn’t right.");
        }
        // The owner may have changed the link while the password was being checked.
        const current = find(token);
        if (current.password_hash !== row.password_hash) fail(409, "This link’s password just changed. Try again.");
        return granted(current, admit(ctx, req, current, visitor!, current.password_hash));
      } finally {
        failures.release(row.id);
      }
    },

    downloaded(access) {
      if (!access.visit) return;
      const now = Date.now();
      ctx.db.tx(() => {
        const visit = ctx.db.get<{ downloads: number; device: string }>(
          "SELECT downloads, device FROM link_visits WHERE id = ?",
          access.visit,
        );
        if (!visit) return;
        ctx.usage.add(access.owner, { downloads: 1 });
        ctx.db.run(
          "UPDATE link_visits SET downloads = downloads + 1, last_download = ?, last = ? WHERE id = ?",
          now,
          now,
          access.visit,
        );
        if (visit.downloads === 0)
          ctx.activity.record(access.owner, {
            kind: "link",
            linkId: access.linkId,
            itemId: access.itemId,
            item: ctx.library.summaries([access.itemId]).get(access.itemId)?.name ?? "",
            action: "downloaded",
            device: visit.device,
          });
      });
      ctx.events.publish(access.owner, "links");
    },

    create(owner, input: LinkInput) {
      const now = Date.now();
      return ctx.db.tx(() => {
        const existing = ctx.db.get<{ owner: string; item: string }>(
          "SELECT owner, item FROM links WHERE id = ?",
          input.id,
        );
        if (existing) {
          if (existing.owner !== owner || existing.item !== input.item) fail(409, "That link id is already in use.");
          return toLinks(ctx, [ownedLink(ctx, owner, input.id, now)], now)[0];
        }
        // The code registry outlives purged links. Never reuse an id from its history: link tokens
        // and pickup codes are derived from that id and otherwise an old share could be revived.
        if (ctx.db.get("SELECT 1 FROM pickup_codes WHERE kind = 'share' AND target_id = ?", input.id))
          fail(409, "That link id has already been used.");
        const item = ctx.library.owned(owner, input.item, { live: true });
        if (ctx.db.get("SELECT 1 FROM nodes WHERE item = ? AND state = 'pending' LIMIT 1", input.item))
          fail(409, "Wait for the uploads to finish before sharing.");
        if (
          !ctx.db.get("SELECT 1 FROM nodes WHERE item = ? AND kind IN ('file', 'text', 'folder') LIMIT 1", input.item)
        )
          fail(409, "There is nothing to share yet.");
        const pickup = issuePickupCode(ctx.db, ctx.secrets, "share", input.id);
        ctx.db.run(
          `INSERT INTO links(id, owner, item, token_hash, code_hash, created, expires, password_hash, visitor_limit, note)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.id,
          owner,
          input.item,
          sha256(ctx.secrets.linkToken(input.id)),
          pickup.codeHash,
          now,
          effectiveLinkExpiry(linkExpiry(allowedLinkDays(ctx, owner, input.days), now), item.expires),
          input.passwordHash ?? null,
          input.visitorLimit ?? null,
          input.note ?? "",
        );
        ctx.events.publish(owner, "links", "items");
        return toLinks(ctx, [ownedLink(ctx, owner, input.id, now)], now)[0];
      });
    },

    forItem(owner, itemId) {
      const now = Date.now();
      const rows = ctx.db.all<LinkRow>(
        `${LINK_SELECT} WHERE l.owner = ? AND l.item = ? AND l.revoked IS NULL AND ${LINK_UNEXPIRED} ORDER BY l.created DESC`,
        now,
        owner,
        itemId,
        now,
      );
      return toLinks(ctx, rows, now).filter((link) => link.available);
    },
  };
}
