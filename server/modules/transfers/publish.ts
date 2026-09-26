import type { Topic } from "../../../shared/model.ts";
import type { Context } from "../../context.ts";

/**
 * Announces a change to an item's contents. A request submission also changes the owner's
 * request page (its received counts), so that topic goes out too. Read the item before purging it.
 */
export function publishItemChange(ctx: Context, owner: string, itemId: string) {
  const topics: Topic[] = ["items"];
  if (ctx.db.value("SELECT request_id FROM items WHERE id = ?", itemId)) topics.push("requests");
  ctx.events.publish(owner, ...topics);
}
