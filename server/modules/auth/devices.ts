import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import type { Device } from "../../../shared/model.ts";
import { clearCookie, sessionCookie } from "../../lib/auth.ts";
import { notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { streamsOf } from "./streams.ts";

type DeviceRow = { id: string; name: string; created: number; seen: number; signed_in: number };

export function registerDevices(app: FastifyInstance, ctx: Context) {
  const streams = streamsOf(ctx);

  route(app, ctx, api.devices.list, ({ member }) =>
    ctx.db
      .all<DeviceRow>(
        `SELECT d.id, d.name, d.created, d.seen,
           EXISTS(SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.expires > ?) AS signed_in
         FROM devices d WHERE d.user_id = ? ORDER BY d.seen DESC`,
        Date.now(),
        member.userId,
      )
      .map((row): Device => ({
        id: row.id,
        name: row.name,
        created: row.created,
        seen: row.seen,
        online: !!row.signed_in && streams.online(row.id),
        current: row.id === member.deviceId,
        signedIn: !!row.signed_in,
      })),
  );

  route(app, ctx, api.devices.rename, ({ member, params, body }) => {
    if (
      !ctx.db.run("UPDATE devices SET name = ? WHERE id = ? AND user_id = ?", body.name, params.id, member.userId)
        .changes
    )
      notFound("That device");
    ctx.events.publish(member.userId, "devices");
    return { ok: true as const };
  });

  route(app, ctx, api.devices.signOut, ({ member, params, reply }) => {
    if (!ctx.db.get("SELECT 1 FROM devices WHERE id = ? AND user_id = ?", params.id, member.userId))
      notFound("That device");
    ctx.db.run("DELETE FROM sessions WHERE device_id = ?", params.id);
    if (params.id === member.deviceId) clearCookie(ctx, reply, sessionCookie(ctx, reply.request));
    streams.recheck();
    ctx.events.publish(member.userId, "devices");
    return { ok: true as const };
  });

  route(app, ctx, api.devices.signOutOthers, ({ member }) => {
    const { changes } = ctx.db.run(
      "DELETE FROM sessions WHERE user_id = ? AND device_id != ?",
      member.userId,
      member.deviceId,
    );
    streams.recheck();
    ctx.events.publish(member.userId, "devices");
    return { removed: changes };
  });
}
