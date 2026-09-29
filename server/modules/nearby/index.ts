// Nearby: Relay introduces devices on the same network so they can send to each other directly (see
// shared/nearby.ts). It keeps who is present, passes their offers and answers along when they may
// reach each other, and admits guests who hold a member's Nearby code. No file ever passes through.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Context, Member } from "../../context.ts";
import { api, headers } from "../../../shared/api.ts";
import type { DeviceKind } from "../../../shared/model.ts";
import {
  NEARBY,
  type NearbyGuestState,
  type NearbyInvite,
  type NearbyPeer,
  type NearbySignal,
} from "../../../shared/nearby.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { clearCookie, cookieOptions, nearbyCookie } from "../../lib/auth.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { cleanLabel } from "../../lib/names.ts";
import { getPickupCode, issuePickupCode } from "../../lib/pickup-codes.ts";
import { randomToken, sha256 } from "../../lib/secrets.ts";
import { perAddress } from "../auth/limits.ts";
import { browserOf, openStream, sessionKey, streamsOf, type EndReason } from "../auth/streams.ts";
import { hubOf, networkOf, type Endpoint } from "./hub.ts";

const INVITE_MS = NEARBY.inviteMinutes * 60_000;
// Setting up one connection takes an offer, an answer and perhaps a goodbye; a page of devices
// connecting at once, and again after a network change, stays well inside this.
const SIGNALS = perAddress(600, "1 minute");

type InviteRow = { id: string; user_id: string; expires: number; host: string; disabled: number };
type GuestRow = { id: string; name: string; kind: DeviceKind; csrf: string };

/** The code behind a guest's link, while it can be used. */
function openInvite(ctx: Context, token: string): InviteRow {
  const invite =
    ctx.db.get<InviteRow>(
      `SELECT n.id, n.user_id, n.expires, coalesce(u.display_name, u.username) AS host, u.disabled
       FROM nearby_invites n JOIN users u ON u.id = n.user_id WHERE n.token_hash = ?`,
      sha256(token),
    ) ?? notFound("That Nearby code");
  if (invite.expires <= Date.now() || invite.disabled) fail(410, "This Nearby code has ended.");
  return invite;
}

/** The guest this browser joined as, by the code's cookie. */
function guestOf(ctx: Context, req: FastifyRequest, invite: InviteRow): GuestRow | null {
  const token = req.cookies[nearbyCookie(ctx, req, invite.id)];
  if (!token) return null;
  return (
    ctx.db.get<GuestRow>(
      "SELECT id, name, kind, csrf FROM nearby_guests WHERE token_hash = ? AND invite_id = ?",
      sha256(token),
      invite.id,
    ) ?? null
  );
}

/**
 * A guest's write. Their cookie is ambient, so, like a session, it needs the guest's own CSRF
 * token alongside (the global hook already checked the origin).
 */
function requireGuest(ctx: Context, req: FastifyRequest, token: string) {
  const invite = openInvite(ctx, token);
  const guest = guestOf(ctx, req, invite) ?? fail(401, "Open the Nearby link again to continue.");
  if (req.headers[headers.csrf.toLowerCase()] !== guest.csrf) fail(403, "Your session has changed. Refresh and retry.");
  return { invite, guest };
}

type DeviceRow = { id: string; user_id: string; name: string; kind: DeviceKind; owner: string };
function devicesById(ctx: Context, ids: string[]) {
  if (!ids.length) return new Map<string, DeviceRow>();
  return new Map(
    ctx.db
      .all<DeviceRow>(
        `SELECT d.id, d.user_id, d.name, d.kind, coalesce(u.display_name, u.username) AS owner
         FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id IN (${ids.map(() => "?").join(", ")})`,
        ...ids,
      )
      .map((row) => [row.id, row]),
  );
}

export function registerNearby(app: FastifyInstance, ctx: Context) {
  const hub = hubOf(ctx);
  const streams = streamsOf(ctx);

  const inviteOf = (userId: string): NearbyInvite | null => {
    const now = Date.now();
    const row = ctx.db.get<{ id: string; expires: number }>(
      "SELECT id, expires FROM nearby_invites WHERE user_id = ? AND expires > ?",
      userId,
      now,
    );
    if (!row) return null;
    const code = getPickupCode(ctx.db, ctx.secrets, "nearby", row.id);
    if (!code) return null;
    const guests = ctx.db.all<{ id: string; name: string; kind: DeviceKind }>(
      "SELECT id, name, kind FROM nearby_guests WHERE invite_id = ? ORDER BY created DESC",
      row.id,
    );
    return {
      id: row.id,
      code,
      token: ctx.secrets.nearbyToken(row.id),
      expires: row.expires,
      guests: guests.map((guest) => ({ ...guest, present: hub.get(guest.id)?.kind === "guest" })),
    };
  };

  /** Everyone this member's device may send to, from where it stands. */
  const peersOf = (member: Member, network: string): NearbyPeer[] => {
    const now = Date.now();
    const own = ctx.db
      .all<{ id: string; name: string; kind: DeviceKind }>(
        `SELECT d.id, d.name, d.kind FROM devices d
         WHERE d.user_id = ? AND d.id != ? AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.expires > ?)
         ORDER BY d.seen DESC`,
        member.userId,
        member.deviceId,
        now,
      )
      .map((device): NearbyPeer => ({
        id: device.id,
        kind: "device",
        name: device.name,
        owner: null,
        deviceKind: device.kind,
        present: hub.get(device.id)?.kind === "device",
      }));
    const self = { id: member.deviceId, kind: "device" as const, userId: member.userId, network };
    const others = [...hub.all()].filter(
      (endpoint) => endpoint.kind === "device" && endpoint.userId !== member.userId && hub.related(self, endpoint),
    );
    const devices = devicesById(
      ctx,
      others.map((endpoint) => endpoint.id),
    );
    const members = others.flatMap((endpoint): NearbyPeer[] => {
      const device = devices.get(endpoint.id);
      return device
        ? [
            {
              id: device.id,
              kind: "member",
              name: device.name,
              owner: device.owner,
              deviceKind: device.kind,
              present: true,
            },
          ]
        : [];
    });
    const guests = (inviteOf(member.userId)?.guests ?? [])
      .filter((guest) => guest.present)
      .map((guest): NearbyPeer => ({
        id: guest.id,
        kind: "guest",
        name: guest.name,
        owner: null,
        deviceKind: guest.kind,
        present: true,
      }));
    const byName = (a: NearbyPeer, b: NearbyPeer) =>
      (a.owner ?? "").localeCompare(b.owner ?? "") || a.name.localeCompare(b.name);
    return [...own, ...members.sort(byName), ...guests];
  };

  const guestState = (invite: InviteRow, guest: GuestRow | null): NearbyGuestState => {
    if (!guest) return { host: invite.host, expires: invite.expires, self: null, peers: [] };
    const present = [...hub.all()].filter(
      (endpoint) => endpoint.kind === "device" && endpoint.userId === invite.user_id,
    );
    const devices = devicesById(
      ctx,
      present.map((endpoint) => endpoint.id),
    );
    return {
      host: invite.host,
      expires: invite.expires,
      self: { id: guest.id, name: guest.name, csrf: guest.csrf },
      peers: present.flatMap((endpoint): NearbyPeer[] => {
        const device = devices.get(endpoint.id);
        return device
          ? [
              {
                id: device.id,
                kind: "host",
                name: device.name,
                owner: invite.host,
                deviceKind: device.kind,
                present: true,
              },
            ]
          : [];
      }),
    };
  };

  /** Passes a signal along, when the two may reach each other. */
  const relay = (from: Endpoint | undefined, to: string, signal: NearbySignal) => {
    if (!from) fail(409, "Open Nearby again to continue.");
    const target = hub.get(to);
    if (!target || !hub.related(from, target)) fail(404, "That device isn’t in Nearby any more.");
    hub.send(target, { type: "signal", from: from.id, signal });
    return { ok: true as const };
  };

  // Member routes.

  route(app, ctx, api.nearby.get, ({ member, req }) => ({
    self: member.deviceId,
    peers: peersOf(member, hub.get(member.deviceId)?.network ?? networkOf(req.ip)),
    invite: inviteOf(member.userId),
    visible: hub.visible(member.userId),
  }));

  route(app, ctx, api.nearby.present, ({ member, body, req }) => {
    const channel =
      streams.channel(sessionKey(member), body.tab) ?? fail(409, "This tab isn’t connected to Relay right now.");
    hub.attach({ id: member.deviceId, kind: "device", userId: member.userId, network: networkOf(req.ip), channel });
    return { ok: true as const };
  });

  route(app, ctx, api.nearby.signal, ({ member, body }) => relay(hub.get(member.deviceId), body.to, body.signal), {
    rateLimit: SIGNALS,
  });

  route(app, ctx, api.nearby.invite, ({ member }) => {
    const now = Date.now();
    ctx.db.tx(() => {
      const current = ctx.db.get<{ id: string; expires: number }>(
        "SELECT id, expires FROM nearby_invites WHERE user_id = ?",
        member.userId,
      );
      if (current && current.expires > now) return;
      // An ended code is never reopened: its guests go with it, and its number is retired.
      if (current) ctx.db.run("DELETE FROM nearby_invites WHERE id = ?", current.id);
      const id = uuidv7(now);
      const { codeHash } = issuePickupCode(ctx.db, ctx.secrets, "nearby", id);
      ctx.db.run(
        "INSERT INTO nearby_invites(id, user_id, token_hash, code_hash, created, expires) VALUES(?, ?, ?, ?, ?, ?)",
        id,
        member.userId,
        sha256(ctx.secrets.nearbyToken(id)),
        codeHash,
        now,
        now + INVITE_MS,
      );
    });
    ctx.events.publish(member.userId, "nearby");
    return inviteOf(member.userId)!;
  });

  route(app, ctx, api.nearby.extendInvite, ({ member }) => {
    const { changes } = ctx.db.run(
      "UPDATE nearby_invites SET expires = ? WHERE user_id = ? AND expires > ?",
      Date.now() + INVITE_MS,
      member.userId,
      Date.now(),
    );
    if (!changes) fail(410, "This Nearby code has ended.");
    ctx.events.publish(member.userId, "nearby");
    hub.tellGuests(member.userId);
    return inviteOf(member.userId)!;
  });

  route(app, ctx, api.nearby.endInvite, ({ member }) => {
    ctx.db.run("DELETE FROM nearby_invites WHERE user_id = ?", member.userId);
    // Its guests' streams end now, rather than at their next check.
    streams.recheck(undefined, member.userId);
    ctx.events.publish(member.userId, "nearby");
    return { ok: true as const };
  });

  route(app, ctx, api.nearby.removeGuest, ({ member, params }) => {
    const { changes } = ctx.db.run(
      `DELETE FROM nearby_guests WHERE id = ? AND invite_id IN (SELECT id FROM nearby_invites WHERE user_id = ?)`,
      params.id,
      member.userId,
    );
    if (!changes) notFound("That guest");
    streams.recheck(undefined, member.userId);
    ctx.events.publish(member.userId, "nearby");
    return { ok: true as const };
  });

  // Guest routes.

  route(app, ctx, api.nearby.guest, ({ params, req }) => {
    const invite = openInvite(ctx, params.token);
    return guestState(invite, guestOf(ctx, req, invite));
  });

  route(
    app,
    ctx,
    api.nearby.join,
    ({ params, body, req, reply }) => {
      const invite = openInvite(ctx, params.token);
      const name = cleanLabel(body.name, NEARBY.guestNameLength) ?? fail(400, "Enter your name.");
      const cookie = nearbyCookie(ctx, req, invite.id);
      // The code's lifetime, not the cookie's, decides how long it works; a session cookie can go.
      const options = { ...cookieOptions(ctx, req, 1), maxAge: undefined };
      const held = guestOf(ctx, req, invite);
      if (held) {
        ctx.db.run("UPDATE nearby_guests SET name = ?, kind = ? WHERE id = ?", name, body.kind, held.id);
        reply.setCookie(cookie, req.cookies[cookie]!, options);
      } else {
        const token = randomToken();
        ctx.db.tx(() => {
          const count = ctx.db.value<number>("SELECT COUNT(*) FROM nearby_guests WHERE invite_id = ?", invite.id)!;
          if (count >= NEARBY.guestsPerInvite) fail(409, "This Nearby code has as many people as it can take.");
          ctx.db.run(
            "INSERT INTO nearby_guests(id, invite_id, token_hash, csrf, name, kind, created) VALUES(?, ?, ?, ?, ?, ?, ?)",
            uuidv7(),
            invite.id,
            sha256(token),
            randomToken(),
            name,
            body.kind,
            Date.now(),
          );
        });
        reply.setCookie(cookie, token, options);
        req.cookies[cookie] = token;
      }
      ctx.events.publish(invite.user_id, "nearby");
      return guestState(invite, guestOf(ctx, req, invite));
    },
    { rateLimit: perAddress(20, "1 minute") },
  );

  route(
    app,
    ctx,
    api.nearby.guestSignal,
    ({ params, body, req }) => {
      const { guest } = requireGuest(ctx, req, params.token);
      return relay(hub.get(guest.id), body.to, body.signal);
    },
    { rateLimit: SIGNALS },
  );

  route(app, ctx, api.nearby.leave, ({ params, req, reply }) => {
    const { invite, guest } = requireGuest(ctx, req, params.token);
    ctx.db.run("DELETE FROM nearby_guests WHERE id = ?", guest.id);
    clearCookie(ctx, reply, nearbyCookie(ctx, req, invite.id));
    streams.recheck(undefined, invite.user_id);
    ctx.events.publish(invite.user_id, "nearby");
    return { ok: true as const };
  });

  app.get<{ Params: { token: string } }>("/api/n/:token/events", (req, reply) => guestStream(ctx, req, reply));
}

/** While a guest holds this stream, they are present to the member's devices. */
function guestStream(ctx: Context, req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) {
  const invite = openInvite(ctx, req.params.token);
  const guest = guestOf(ctx, req, invite) ?? fail(401, "Open the Nearby link again to continue.");
  const ended = (): EndReason | null => {
    const row = ctx.db.get<{ guest: string | null }>(
      `SELECT g.id AS guest FROM nearby_invites n JOIN users u ON u.id = n.user_id
       LEFT JOIN nearby_guests g ON g.id = ? AND g.invite_id = n.id
       WHERE n.id = ? AND n.expires > ? AND u.disabled = 0`,
      guest.id,
      invite.id,
      Date.now(),
    );
    // The code ended, or this guest left or was removed.
    if (!row) return "expired";
    return row.guest ? null : "signed-out";
  };
  const channel = openStream(
    ctx,
    reply,
    {
      userId: invite.user_id,
      deviceId: null,
      capKey: `nearby:${guest.id}`,
      cap: 2,
      browser: browserOf(req),
      ended,
      lease: null,
    },
    false,
  );
  if (channel)
    hubOf(ctx).attach({ id: guest.id, kind: "guest", userId: invite.user_id, network: networkOf(req.ip), channel });
}
