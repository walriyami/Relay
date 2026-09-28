// What the administrator allows each member. Limits are enforced by bringing choices within them
// rather than refusing: a link asked to last longer than allowed lasts as long as allowed.
import type { Context } from "../../context.ts";
import { DEFAULTS, NO_LIMITS, withinLimit, type LimitsApplied, type MemberLimits } from "../../../shared/model.ts";
import { DAY_MS } from "../../lib/time.ts";

/** The limit columns of `users` and `invites`. */
export const LIMIT_COLUMNS = "quota, max_retention_days, max_link_days";
export type LimitRow = { quota: number | null; max_retention_days: number | null; max_link_days: number | null };

export const toLimits = (row: LimitRow): MemberLimits => ({
  storage: row.quota,
  keepDays: row.max_retention_days,
  linkDays: row.max_link_days,
});
/** Column values in LIMIT_COLUMNS order. */
export const limitValues = (limits: MemberLimits) => [limits.storage, limits.keepDays, limits.linkDays] as const;

export function memberLimitsOf(ctx: Context, userId: string): MemberLimits {
  const row = ctx.db.get<LimitRow>(`SELECT ${LIMIT_COLUMNS} FROM users WHERE id = ?`, userId);
  return row ? toLimits(row) : NO_LIMITS;
}

/** How long a new or re-dated link of the member may work: `days`, or their limit if that is shorter. */
export const allowedLinkDays = (ctx: Context, userId: string, days: number | null) =>
  withinLimit(days, memberLimitsOf(ctx, userId).linkDays);

/** The choice for Files within the maximum total age: `days`, or their limit if that is shorter. */
export const allowedKeepDays = (ctx: Context, userId: string, days: number | null) =>
  withinLimit(days, memberLimitsOf(ctx, userId).keepDays);

/**
 * Sets a member's limits inside the caller's transaction and applies them at once: their own
 * settings come within them. A total-age cap applies from the first save, including Trash.
 * Each item remembers its strictest cap; loosening never extends existing content.
 */
export function applyMemberLimits(ctx: Context, userId: string, limits: MemberLimits, now: number): LimitsApplied {
  ctx.db.run(
    "UPDATE users SET quota = ?, max_retention_days = ?, max_link_days = ? WHERE id = ?",
    ...limitValues(limits),
    userId,
  );
  const user = ctx.db.get<{ retention_days: number | null; prefs: string }>(
    "SELECT retention_days, prefs FROM users WHERE id = ?",
    userId,
  )!;
  ctx.db.run(
    "UPDATE users SET retention_days = ? WHERE id = ?",
    withinLimit(user.retention_days, limits.keepDays),
    userId,
  );
  // As the member saved them; without a choice of their own, new links get the built-in lifetime.
  const prefs = JSON.parse(user.prefs) as { linkDays?: number | null };
  const linkDays = prefs.linkDays === undefined ? DEFAULTS.linkDays : prefs.linkDays;
  if (withinLimit(linkDays, limits.linkDays) !== linkDays)
    ctx.db.run(
      "UPDATE users SET prefs = ? WHERE id = ?",
      JSON.stringify({ ...prefs, linkDays: withinLimit(linkDays, limits.linkDays) }),
      userId,
    );
  const shortened = { links: 0, items: 0, requests: 0 };
  if (limits.linkDays !== null) {
    const end = now + limits.linkDays * DAY_MS;
    shortened.requests = Number(
      ctx.db.run("UPDATE requests SET expires = ? WHERE owner = ? AND closed IS NULL AND expires > ?", end, userId, end)
        .changes,
    );
    ctx.db.run(
      `UPDATE guest_grants SET expires = min(expires, (SELECT expires FROM requests WHERE id = request_id))
       WHERE request_id IN (SELECT id FROM requests WHERE owner = ?)`,
      userId,
    );
  }
  if (limits.keepDays !== null) {
    shortened.items = Number(
      ctx.db.run(
        `UPDATE items SET max_age_days = ?,
         retention_days = CASE WHEN retention_days IS NULL THEN ? ELSE min(retention_days, ?) END,
         expires = CASE WHEN first_saved_at IS NULL THEN NULL
           WHEN expires IS NULL THEN first_saved_at + ? ELSE min(expires, first_saved_at + ?) END,
         purge_at = CASE WHEN first_saved_at IS NULL OR purge_at IS NULL THEN purge_at ELSE min(purge_at, first_saved_at + ?) END
       WHERE owner = ? AND (max_age_days IS NULL OR max_age_days > ?)`,
        limits.keepDays,
        limits.keepDays,
        limits.keepDays,
        limits.keepDays * DAY_MS,
        limits.keepDays * DAY_MS,
        limits.keepDays * DAY_MS,
        userId,
        limits.keepDays,
      ).changes,
    );
  }
  // File shortening can impose an earlier deadline than the link cap. Never lengthen an old link.
  const linkEnd = limits.linkDays === null ? null : now + limits.linkDays * DAY_MS;
  shortened.links = Number(
    ctx.db.run(
      `WITH deadlines AS (
       SELECT l.id, CASE WHEN i.expires IS NULL THEN ? WHEN ? IS NULL THEN i.expires
         ELSE min(i.expires, ?) END AS deadline
       FROM links l JOIN items i ON i.id = l.item WHERE l.owner = ? AND l.revoked IS NULL
     )
     UPDATE links SET expires = (SELECT deadline FROM deadlines WHERE id = links.id)
     WHERE id IN (SELECT id FROM deadlines WHERE deadline IS NOT NULL)
       AND (expires IS NULL OR expires > (SELECT deadline FROM deadlines WHERE id = links.id))`,
      linkEnd,
      linkEnd,
      linkEnd,
      userId,
    ).changes,
  );
  return shortened;
}
