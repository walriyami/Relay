// Administrator password recovery for the owner of the server. Nobody can reset the password of the
// last administrator from inside Relay, so the owner sets RELAY_RECOVER_ADMIN=<username> in the
// app's settings; at startup Relay writes a one-time link to its log, which only the owner can
// read (see docs/hosting.md). The link sets a new password and signs that account out everywhere.
import type { FastifyInstance } from "fastify";
import { api } from "../../../shared/api.ts";
import type { Context } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { hashPassword, randomToken, sha256 } from "../../lib/secrets.ts";
import { DAY_MS } from "../auth/sessions.ts";
import { perAddress } from "../auth/limits.ts";
import { recordHistory } from "../history/index.ts";
import { streamsOf } from "../auth/streams.ts";

/** The open link: who it is for and until when. Only the token's hash is kept. */
const PENDING = "recovery";
/** The RELAY_RECOVER_ADMIN value whose link was used, so a restart does not issue another. */
const USED = "recovery.used";

type Pending = { hash: string; userId: string; expires: number };

/**
 * Issues a fresh link (replacing any earlier one) when RELAY_RECOVER_ADMIN names an administrator,
 * and returns it for the log. With the setting cleared, any open link stops working.
 */
export function issueRecovery(ctx: Context): { message: string; link?: string } | undefined {
  const username = ctx.config.recoverAdmin?.trim().toLowerCase();
  if (!username) {
    ctx.db.tx(() => ctx.db.run("DELETE FROM settings WHERE key IN (?, ?)", PENDING, USED));
    return undefined;
  }
  if (ctx.db.setting(USED) === username) {
    ctx.db.run("DELETE FROM settings WHERE key = ?", PENDING);
    return {
      message: `The recovery link for ${username} was already used. Clear RELAY_RECOVER_ADMIN in the app's settings.`,
    };
  }
  const user = ctx.db.get<{ id: string; admin: number }>("SELECT id, admin FROM users WHERE username = ?", username);
  if (!user?.admin) {
    ctx.db.run("DELETE FROM settings WHERE key = ?", PENDING);
    return { message: `RELAY_RECOVER_ADMIN names "${username}", which is not an administrator. No link was made.` };
  }
  const token = randomToken();
  const pending: Pending = { hash: sha256(token), userId: user.id, expires: Date.now() + DAY_MS };
  ctx.db.setSetting(PENDING, JSON.stringify(pending));
  const link = `${ctx.config.origin ?? ""}/recover#${token}`;
  return {
    message: `Administrator recovery link for ${username}, valid for 24 hours and usable once: ${link}`,
    link,
  };
}

export function registerRecovery(app: FastifyInstance, ctx: Context) {
  const open = (token: string) => {
    const stored = ctx.db.setting(PENDING);
    const pending = stored ? (JSON.parse(stored) as Pending) : undefined;
    const username =
      pending &&
      pending.hash === sha256(token) &&
      pending.expires > Date.now() &&
      ctx.db.value<string>("SELECT username FROM users WHERE id = ? AND admin = 1", pending.userId);
    if (!pending || !username)
      fail(410, "This recovery link has expired or was already used. Restart Relay to get a new one.");
    return { ...pending, username };
  };

  route(
    app,
    ctx,
    api.recovery.check,
    ({ body }) => {
      const { username, expires } = open(body.token);
      return { username, expires };
    },
    { rateLimit: perAddress(20, "1 minute") },
  );

  route(
    app,
    ctx,
    api.recovery.reset,
    async ({ body }) => {
      open(body.token);
      const hash = await hashPassword(body.password);
      const userId = ctx.db.tx(() => {
        // Hashing awaited; the link may have been used or replaced meanwhile.
        const pending = open(body.token);
        ctx.db.run("UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?", hash, pending.userId);
        ctx.db.run("DELETE FROM passkeys WHERE user_id = ?", pending.userId);
        ctx.db.run("DELETE FROM sessions WHERE user_id = ?", pending.userId);
        ctx.db.run("DELETE FROM settings WHERE key = ?", PENDING);
        ctx.db.setSetting(USED, pending.username);
        ctx.activity.record(pending.userId, { kind: "password", device: null });
        recordHistory(ctx, { kind: "password", username: pending.username, by: null }, pending.userId);
        return pending.userId;
      });
      ctx.log.warn({ user: userId }, "administrator password was reset with the recovery link");
      streamsOf(ctx).recheck({ userId, reason: "password-reset" });
      ctx.events.publish(userId, "account", "devices");
      return { ok: true as const };
    },
    { rateLimit: perAddress(10, "1 minute") },
  );
}
