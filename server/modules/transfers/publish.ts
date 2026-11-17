import type { Topic } from "../../../shared/model.ts";
import type { Context } from "../../context.ts";

/**
 * Announces a change to an item's contents. A request submission also changes the owner's
 * request page (its received counts), so that topic goes out too. Read the item before purging it.
 *
 * Reserving or releasing space changes what every member can still upload, so by default everyone
 * hears about it. A finished file only turns its reserved bytes into saved ones: then the free
 * space everyone else sees is unchanged, and only the owner and administrators are told.
 */
export function publishItemChange(ctx: Context, owner: string, itemId: string, { sharedSpace = true } = {}) {
  const topics: Topic[] = ["items"];
  if (ctx.db.value("SELECT request_id FROM items WHERE id = ?", itemId)) topics.push("requests");
  ctx.events.publish(owner, ...topics);
  if (sharedSpace) ctx.events.broadcast("account");
  else
    for (const id of new Set([
      owner,
      ...ctx.db.all<{ id: string }>("SELECT id FROM users WHERE admin = 1").map((u) => u.id),
    ]))
      ctx.events.publish(id, "account");
}
