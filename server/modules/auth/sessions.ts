import type { FastifyReply } from "fastify";
import type { Context } from "../../context.ts";
import {
  DEFAULTS,
  type ActivityGroup,
  type ActivityPrefs,
  type Me,
  type Prefs,
  type SignInMethod,
  type Usage,
  type User,
} from "../../../shared/model.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { cookieOptions, sessionCookie } from "../../lib/auth.ts";
import { fail } from "../../lib/errors.ts";
import { randomToken, sha256 } from "../../lib/secrets.ts";

export const DAY_MS = 86_400_000;
const SESSION_MS = DEFAULTS.sessionDays * DAY_MS;

export type UserRow = {
  id: string;
  username: string;
  display_name: string | null;
  admin: number;
  quota: number;
  retention_days: number | null;
  prefs: string;
};
export const USER_COLUMNS = "id, username, display_name, admin, quota, retention_days, prefs";

export const toUser = (
  row: Pick<UserRow, "id" | "username" | "display_name" | "admin" | "quota" | "retention_days">,
): User => ({
  id: row.id,
  username: row.username,
  name: row.display_name,
  admin: !!row.admin,
  quota: row.quota,
  retentionDays: row.retention_days,
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

/** Saved bytes (kept exact by triggers) plus bytes reserved by the user's unfinished uploads. */
export function usageOf(ctx: Context, userId: string): Usage {
  const row = ctx.db.get<Usage>(
    `SELECT bytes_used AS used, quota,
       (SELECT ifnull(SUM(size), 0) FROM nodes WHERE owner = users.id AND state = 'pending') AS reserved
     FROM users WHERE id = ?`,
    userId,
  );
  return row ? { used: row.used, reserved: row.reserved, quota: row.quota } : fail(401, "Sign in to continue.");
}

export function me(ctx: Context, userId: string, deviceId: string, csrf: string): Me {
  const user =
    ctx.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, userId) ?? fail(401, "Sign in to continue.");
  const device = ctx.db.get<{ name: string }>("SELECT name FROM devices WHERE id = ?", deviceId);
  return {
    user: toUser(user),
    csrf,
    device: { id: deviceId, name: device?.name ?? "" },
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
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
  return candidate;
}

export type NewSession = { userId: string; token: string; csrf: string; deviceId: string };

/**
 * Records a new browser (device) and its session. Synchronous so callers can consume an invite or
 * login code in the same transaction; `finishSignIn` sets the cookie once that has committed.
 */
export function insertSession(ctx: Context, userId: string, deviceName: string, method: SignInMethod): NewSession {
  const now = Date.now();
  const session = { userId, token: randomToken(), csrf: randomToken(), deviceId: uuidv7(now) };
  ctx.db.tx(() => {
    if (!ctx.db.get("SELECT 1 FROM users WHERE id = ? AND disabled = 0", userId))
      fail(403, "This account is disabled. Contact the administrator.");
    const name = distinctName(ctx, userId, deviceName, now);
    ctx.db.run(
      "INSERT INTO devices(id, user_id, name, created, seen) VALUES(?, ?, ?, ?, ?)",
      session.deviceId,
      userId,
      name,
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
  reply.setCookie(sessionCookie(ctx), session.token, cookieOptions(ctx, SESSION_MS));
  ctx.events.publish(session.userId, "devices");
  return me(ctx, session.userId, session.deviceId, session.csrf);
}

export const DEFAULT_DEVICE_NAME = "Browser";
