import type { Context, ItemRow } from "../../context.ts";
import { withinLimit } from "../../../shared/model.ts";
import { DAY_MS } from "../../lib/time.ts";

/** Null is an unbounded deadline. All expiry comparisons use the exclusive upper bound. */
export const earlier = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
export const afterDays = (now: number, days: number | null) => (days === null ? null : now + days * DAY_MS);

/** The first save and a non-increasing age limit define an irreversible maximum lifetime. */
export const hardDeadline = (item: Pick<ItemRow, "first_saved_at" | "max_age_days">) =>
  item.first_saved_at === null ? null : afterDays(item.first_saved_at, item.max_age_days);

/** Called in the transaction that first makes meaningful content ready, including empty files. */
export function startRetention(ctx: Context, itemId: string, now = Date.now()) {
  const item = ctx.db.get<ItemRow>("SELECT * FROM items WHERE id = ?", itemId)!;
  if (item.first_saved_at !== null) return;
  const cap = ctx.db.value<number | null>("SELECT max_retention_days FROM users WHERE id = ?", item.owner)!;
  const maxAge = withinLimit(item.max_age_days, cap);
  const days = withinLimit(item.retention_days, maxAge);
  ctx.db.run(
    "UPDATE items SET first_saved_at = ?, max_age_days = ?, retention_days = ?, expires = ? WHERE id = ?",
    now,
    maxAge,
    days,
    afterDays(now, days),
    itemId,
  );
  shortenItemLinks(ctx, itemId);
}

/** An item's renewal never renews a share; shortening is permanent until an explicit link edit. */
export function shortenItemLinks(ctx: Context, itemId: string) {
  ctx.db.run(
    `UPDATE links SET expires = (SELECT expires FROM items WHERE id = ?)
     WHERE item = ? AND revoked IS NULL
       AND (SELECT expires FROM items WHERE id = ?) IS NOT NULL
       AND (expires IS NULL OR expires > (SELECT expires FROM items WHERE id = ?))`,
    itemId,
    itemId,
    itemId,
    itemId,
  );
}

/** Caller must validate that the item is live, or recoverable Trash for an explicit restore. */
export function setRetention(ctx: Context, item: ItemRow, days: number | null, now = Date.now()) {
  const cap = ctx.db.value<number | null>("SELECT max_retention_days FROM users WHERE id = ?", item.owner)!;
  const chosen = withinLimit(days, withinLimit(item.max_age_days, cap));
  ctx.db.run(
    "UPDATE items SET retention_days = ?, expires = ? WHERE id = ?",
    chosen,
    item.first_saved_at === null ? null : earlier(afterDays(now, chosen), hardDeadline(item)),
    item.id,
  );
  shortenItemLinks(ctx, item.id);
}
