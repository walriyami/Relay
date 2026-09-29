import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import type { Device } from "../../../shared/model.ts";
import { clearCookie, sessionCookie } from "../../lib/auth.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { streamsOf } from "./streams.ts";
import { hubOf } from "../nearby/hub.ts";

type DeviceRow = Pick<Device, "id" | "name" | "kind" | "created" | "seen"> & { signed_in: number };

export function registerDevices(app: FastifyInstance, ctx: Context) {
  const streams = streamsOf(ctx);

  route(app, ctx, api.devices.list, ({ member }) => {
    const online = streams.presence(member.userId);
    return ctx.db
      .all<DeviceRow>(
        `SELECT d.id, d.name, d.kind, d.created, d.seen,
           EXISTS(SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.expires > ?) AS signed_in
         FROM devices d WHERE d.user_id = ? ORDER BY d.seen DESC`,
        Date.now(),
        member.userId,
      )
      .map((row): Device => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        created: row.created,
        seen: row.seen,
        online: !!row.signed_in && online.has(row.id),
        current: row.id === member.deviceId,
        signedIn: !!row.signed_in,
      }));
  });

  // Names tell devices apart when sending and signing out, so two signed-in devices can't share one.
  route(app, ctx, api.devices.update, ({ member, params, body }) => {
    ctx.db.tx(() => {
      if (!ctx.db.get("SELECT 1 FROM devices WHERE id = ? AND user_id = ?", params.id, member.userId))
        notFound("That device");
      const taken = ctx.db
        .all<{ name: string }>(
          `SELECT d.name FROM devices d
            WHERE d.user_id = ? AND d.id != ? AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.expires > ?)`,
          member.userId,
          params.id,
          Date.now(),
        )
        .some((d) => d.name.toLowerCase() === body.name.toLowerCase());
      if (taken) fail(409, "Another signed-in device already has that name.");
      ctx.db.run(
        "UPDATE devices SET name = ?, kind = coalesce(?, kind) WHERE id = ?",
        body.name,
        body.kind ?? null,
        params.id,
      );
    });
    ctx.events.publish(member.userId, "devices");
    hubOf(ctx).userChanged(member.userId);
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
