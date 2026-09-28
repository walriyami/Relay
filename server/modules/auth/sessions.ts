import type { FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../../context.ts";
import {
  DEFAULTS,
  LIMITS,
  type ActivityGroup,
  type ActivityPrefs,
  type DeviceKind,
  type Me,
  type Prefs,
  type SignInMethod,
  type Usage,
  type User,
} from "../../../shared/model.ts";
import { deviceKind } from "../../../shared/devices.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { cookieOptions, sessionCookie } from "../../lib/auth.ts";
import { fail } from "../../lib/errors.ts";
import { randomToken, sha256 } from "../../lib/secrets.ts";
import { capacityOf } from "../admin/settings.ts";
import { LIMIT_COLUMNS, toLimits, type LimitRow } from "./member-limits.ts";

export const DAY_MS = 86_400_000;
const SESSION_MS = DEFAULTS.sessionDays * DAY_MS;

export type UserRow = LimitRow & {
  id: string;
  username: string;
  display_name: string | null;
  admin: number;
  retention_days: number | null;
  trash_days: number;
  prefs: string;
};
export const USER_COLUMNS = `id, username, display_name, admin, ${LIMIT_COLUMNS}, retention_days, trash_days, prefs`;

export const toUser = (row: Omit<UserRow, "prefs">): User => ({
  id: row.id,
  username: row.username,
  name: row.display_name,
  admin: !!row.admin,
  limits: toLimits(row),
  retentionDays: row.retention_days,
  trashDays: row.trash_days,
});

/** The name a member shows other people: their display name, or else their username. */
export const publicName = (ctx: Context, userId: string) =>
  ctx.db.value<string>("SELECT coalesce(display_name, username) FROM users WHERE id = ?", userId) ?? "";

export function readPrefs(json: string): Prefs {
  const stored = JSON.parse(json) as Partial<Prefs>;
  const activity: Partial<ActivityPrefs> = stored.activity ?? {};
  const shown = (group: ActivityGroup) => (typeof activity[group] === "boolean" ? activity[group] : true);
  return {
    // null keeps new links until they are turned off.
    linkDays: typeof stored.linkDays === "number" || stored.linkDays === null ? stored.linkDays : DEFAULTS.linkDays,
    autoCopyLink: typeof stored.autoCopyLink === "boolean" ? stored.autoCopyLink : true,
    activity: {
      received: shown("received"),
      requests: shown("requests"),
      links: shown("links"),
      security: shown("security"),
      members: shown("members"),
    },
  };
}

/** What the total storage has left for anyone: capacity less everything saved and reserved. */
export function storageFree(ctx: Context) {
  const taken = ctx.db.value<number>(
    `SELECT (SELECT ifnull(SUM(bytes_used), 0) FROM users)
          + (SELECT ifnull(SUM(size), 0) FROM nodes WHERE state = 'pending')`,
  )!;
  return Math.max(0, capacityOf(ctx) - taken);
}

/**
 * Saved bytes (kept exact by triggers), bytes reserved by the user's unfinished uploads, and what
 * they can still upload. `free` is `storageFree`, passed when reading many members at once.
 */
export function usageOf(ctx: Context, userId: string, free = storageFree(ctx)): Usage {
  const row = ctx.db.get<{ used: number; reserved: number; quota: number | null }>(
    `SELECT bytes_used AS used, quota,
       (SELECT ifnull(SUM(size), 0) FROM nodes WHERE owner = users.id AND state = 'pending') AS reserved
     FROM users WHERE id = ?`,
    userId,
  );
  if (!row) return fail(401, "Sign in to continue.");
  const own = row.quota === null ? free : Math.max(0, row.quota - row.used - row.reserved);
  return { used: row.used, reserved: row.reserved, available: Math.min(own, free) };
}

export function me(ctx: Context, userId: string, deviceId: string, csrf: string): Me {
  const user =
    ctx.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, userId) ?? fail(401, "Sign in to continue.");
  const device = ctx.db.get<{ name: string; kind: DeviceKind }>(
    "SELECT name, kind FROM devices WHERE id = ?",
    deviceId,
  );
  return {
    user: toUser(user),
    csrf,
    device: { id: deviceId, name: device?.name ?? "", kind: device?.kind ?? "computer" },
    prefs: readPrefs(user.prefs),
    usage: usageOf(ctx, userId),
  };
}

/**
 * Two browsers of one kind would both be "Chrome on Mac"; the newer becomes "Chrome on Mac 2", so
 * every signed-in device can be told apart, as renaming also requires.
 */
function distinctName(ctx: Context, userId: string, name: string, now: number) {
  const taken = new Set(
    ctx.db
      .all<{ name: string }>(
        `SELECT d.name FROM devices d
          WHERE d.user_id = ? AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.expires > ?)`,
        userId,
        now,
      )
      .map((d) => d.name.toLowerCase()),
  );
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    const suffix = ` ${n}`;
    const maxBaseLength = LIMITS.nameLength - suffix.length;
    let base = "";
    for (const character of name) {
      if (base.length + character.length > maxBaseLength) break;
      base += character;
    }
    candidate = `${base}${suffix}`;
  }
  return candidate;
}

const DEFAULT_DEVICE_NAME = "Browser";

export type NewDevice = { name: string; kind: DeviceKind };
/**
 * The browser signing in: the name it asked for, and what it is. Its own answer is preferred, since
 * only it can tell an iPad from the Mac its user agent claims to be.
 */
export const newDevice = (req: FastifyRequest, hint: { deviceName?: string; deviceKind?: DeviceKind }): NewDevice => ({
  name: hint.deviceName ?? DEFAULT_DEVICE_NAME,
  kind: hint.deviceKind ?? deviceKind(String(req.headers["user-agent"] ?? "")),
});

export type NewSession = { userId: string; token: string; csrf: string; deviceId: string };

/**
 * Records a new browser (device) and its session. Synchronous so callers can consume an invite or
 * login code in the same transaction; `finishSignIn` sets the cookie once that has committed.
 */
export function insertSession(ctx: Context, userId: string, device: NewDevice, method: SignInMethod): NewSession {
  const now = Date.now();
  const session = { userId, token: randomToken(), csrf: randomToken(), deviceId: uuidv7(now) };
  ctx.db.tx(() => {
    if (!ctx.db.get("SELECT 1 FROM users WHERE id = ? AND disabled = 0", userId))
      fail(403, "This account is disabled. Contact the administrator.");
    const name = distinctName(ctx, userId, device.name, now);
    ctx.db.run(
      "INSERT INTO devices(id, user_id, name, kind, created, seen) VALUES(?, ?, ?, ?, ?, ?)",
      session.deviceId,
      userId,
      name,
      device.kind,
      now,
      now,
    );
    ctx.activity.record(userId, { kind: "signin", deviceId: session.deviceId, device: name, method }, session.deviceId);
    ctx.db.run(
      "INSERT INTO sessions(token_hash, user_id, device_id, csrf, created, expires) VALUES(?, ?, ?, ?, ?, ?)",
      sha256(session.token),
      userId,
      session.deviceId,
      session.csrf,
      now,
      now + SESSION_MS,
    );
  });
  return session;
}

export function finishSignIn(ctx: Context, reply: FastifyReply, session: NewSession): Me {
  reply.setCookie(sessionCookie(ctx, reply.request), session.token, cookieOptions(ctx, reply.request, SESSION_MS));
  ctx.events.publish(session.userId, "devices");
  return me(ctx, session.userId, session.deviceId, session.csrf);
}
