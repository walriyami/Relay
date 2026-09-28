import type { Context, ItemRow } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { hardDeadline } from "../library/retention.ts";

export type TransferTarget = { owner: string; principal: string; item?: string };
type Unavailable = { status: number; message: string; expired?: boolean; cancel?: "item" | "principal" };

/** Read-only so publication can check again inside its synchronous transaction. */
function unavailable(ctx: Context, target: TransferTarget, now: number): Unavailable | null {
  if (target.item) {
    const item = ctx.db.get<ItemRow>("SELECT * FROM items WHERE id = ? AND owner = ?", target.item, target.owner);
    if (!item) return { status: 404, message: "That item could not be found." };
    const hard = hardDeadline(item);
    if (item.trashed !== null || (item.expires !== null && item.expires <= now) || (hard !== null && hard <= now))
      return {
        status: 410,
        message: "This item is in Trash or has expired.",
        expired: item.trashed === null,
        cancel: "item",
      };
  }
  if (target.principal.startsWith("grant:")) {
    if (
      !ctx.db.get(
        `SELECT 1 FROM guest_grants g JOIN requests r ON r.id = g.request_id
       WHERE g.token_hash = ? AND g.expires > ? AND r.owner = ? AND r.closed IS NULL AND r.expires > ?
         AND (g.item IS NULL OR g.item = ?)`,
        target.principal.slice(6),
        now,
        target.owner,
        now,
        target.item ?? null,
      )
    )
      return { status: 410, message: "This request is no longer accepting uploads.", cancel: "principal" };
  } else if (target.principal !== `user:${target.owner}`) {
    return { status: 404, message: "That transfer could not be found." };
  }
  if (!ctx.db.get("SELECT 1 FROM users WHERE id = ? AND disabled = 0", target.owner))
    return { status: 410, message: "This account is no longer accepting uploads." };
  return null;
}

export function assertTransferAvailability(ctx: Context, target: TransferTarget, now = Date.now()) {
  const issue = unavailable(ctx, target, now);
  if (issue) fail(issue.status, issue.message);
}

/** Call outside a transaction that may throw, so invalidation and reservation release stay durable. */
export function settleTransferAvailability(ctx: Context, target: TransferTarget, now = Date.now()) {
  const issue = unavailable(ctx, target, now);
  if (!issue) return;
  if (target.item) {
    if (issue.expired) ctx.library.trash(target.owner, target.item);
    else if (issue.cancel)
      ctx.transfers.cancelForItem(target.item, issue.cancel === "principal" ? target.principal : undefined);
  }
  return issue;
}

export function ensureTransferAvailability(ctx: Context, target: TransferTarget, now = Date.now()) {
  const issue = settleTransferAvailability(ctx, target, now);
  if (issue) fail(issue.status, issue.message);
}
