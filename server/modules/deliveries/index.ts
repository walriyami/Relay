// Sending an item to one of the owner's own devices. The recipient opens the item with its own
// member access (same owner), so no public link is involved.
import type { FastifyInstance } from "fastify";
import type { Context, Deliveries } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import type { Delivery, DeliveryState } from "../../../shared/model.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { streamsOf } from "../auth/streams.ts";

type DeliveryRow = {
  id: string;
  owner: string;
  item: string;
  state: DeliveryState;
  created: number;
  answered: number | null;
  from_device: string | null;
  from_name: string | null;
  to_device: string;
  to_name: string;
  item_live: number;
};
/** `?` is the current time. */
const SELECT = `SELECT d.id, d.owner, d.item, d.state, d.created, d.answered, d.from_device, f.name AS from_name, d.to_device, t.name AS to_name,
    (i.trashed IS NULL AND (i.expires IS NULL OR i.expires > ?)) AS item_live
  FROM deliveries d JOIN items i ON i.id = d.item JOIN devices t ON t.id = d.to_device LEFT JOIN devices f ON f.id = d.from_device`;

function toDeliveries(ctx: Context, rows: DeliveryRow[]): Delivery[] {
  const summaries = ctx.library.summaries([...new Set(rows.map((r) => r.item))]);
  return rows.map((row) => ({
    id: row.id,
    itemId: row.item,
    state: row.state,
    created: row.created,
    answered: row.answered,
    from: row.from_device ? { id: row.from_device, name: row.from_name! } : null,
    to: { id: row.to_device, name: row.to_name },
    available: !!row.item_live,
    item: summaries.get(row.item) ?? null,
  }));
}

const one = (ctx: Context, id: string) =>
  toDeliveries(ctx, [ctx.db.get<DeliveryRow>(`${SELECT} WHERE d.id = ?`, Date.now(), id)!])[0];

export function createDeliveries(ctx: Context): Deliveries {
  return {
    create(owner, fromDevice, input) {
      return ctx.db.tx(() => {
        const existing = ctx.db.get<{ owner: string; item: string; to_device: string }>(
          "SELECT owner, item, to_device FROM deliveries WHERE id = ?",
          input.id,
        );
        if (existing) {
          if (existing.owner !== owner || existing.item !== input.item || existing.to_device !== input.device)
            fail(409, "That delivery id is already in use.");
          return one(ctx, input.id);
        }
        if (!ctx.db.get("SELECT 1 FROM devices WHERE id = ? AND user_id = ?", input.device, owner))
          notFound("That device");
        if (!ctx.db.get("SELECT 1 FROM sessions WHERE device_id = ? AND expires > ?", input.device, Date.now()))
          fail(409, "That device is not online.");
        if (!streamsOf(ctx).online(input.device)) fail(409, "That device is not online.");
        ctx.library.owned(owner, input.item, { live: true });
        if (ctx.db.get("SELECT 1 FROM nodes WHERE item = ? AND state = 'pending' LIMIT 1", input.item))
          fail(409, "Wait for the uploads to finish before sending.");
        ctx.db.run(
          "INSERT INTO deliveries(id, owner, item, from_device, to_device, state, created) VALUES(?, ?, ?, ?, ?, 'available', ?)",
          input.id,
          owner,
          input.item,
          fromDevice,
          input.device,
          Date.now(),
        );
        ctx.events.publish(owner, "deliveries");
        return one(ctx, input.id);
      });
    },
  };
}

export function registerDeliveries(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.deliveries.list, ({ member, query }) => {
    const rows =
      query.direction === "incoming"
        ? ctx.db.all<DeliveryRow>(
            // Waiting deliveries remain actionable even after a long history of answered arrivals.
            // Only the answered history is bounded; both groups keep their newest-first order.
            `WITH incoming AS (${SELECT} WHERE d.owner = ? AND d.to_device = ? AND item_live)
             SELECT * FROM incoming
             WHERE state = 'available' OR id IN (
               SELECT id FROM incoming WHERE state <> 'available' ORDER BY created DESC, id DESC LIMIT 100
             )
             ORDER BY created DESC, id DESC`,
            Date.now(),
            member.userId,
            member.deviceId,
          )
        : ctx.db.all<DeliveryRow>(
            `${SELECT} WHERE d.owner = ? AND d.from_device = ? ORDER BY d.created DESC LIMIT 100`,
            Date.now(),
            member.userId,
            member.deviceId,
          );
    return toDeliveries(ctx, rows);
  });

  route(app, ctx, api.deliveries.create, ({ member, body }) =>
    ctx.deliveries.create(member.userId, member.deviceId, body),
  );

  route(app, ctx, api.deliveries.update, ({ member, params, body }) => {
    const found =
      ctx.db.get<{ state: DeliveryState }>(
        "SELECT state FROM deliveries WHERE id = ? AND owner = ? AND to_device = ?",
        params.id,
        member.userId,
        member.deviceId,
      ) ?? notFound("That delivery");
    // Downloading a declined delivery later accepts it after all; an accepted one stays accepted.
    const changed = found.state === "available" || (found.state === "declined" && body.state === "accepted");
    if (changed) {
      ctx.db.run("UPDATE deliveries SET state = ?, answered = ? WHERE id = ?", body.state, Date.now(), params.id);
      ctx.events.publish(member.userId, "deliveries");
    }
    return { state: changed ? body.state : found.state, changed };
  });
}
