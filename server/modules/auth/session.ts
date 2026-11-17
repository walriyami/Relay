import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import { clearCookie, sessionCookie } from "../../lib/auth.ts";
import { fail } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { dummyPasswordHash, hashPassword, sha256 } from "../../lib/secrets.ts";
import { perAddress } from "./limits.ts";
import { checkPassword } from "./passwords.ts";
import { finishSignIn, insertSession, me, newDevice } from "./sessions.ts";
import { streamsOf } from "./streams.ts";
import { LIMIT_COLUMNS, toLimits, type LimitRow } from "./member-limits.ts";
import { insertUser } from "./users.ts";
import { recordHistory, usernameOf } from "../history/index.ts";

export const SIGN_IN_LIMIT = perAddress(10, "1 minute");
/** One answer for expired, used, withdrawn and unknown invitations alike. */
const INVITE_GONE = "This invitation can’t be used any more. Ask for a new link.";

export function registerSession(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.session.get, ({ member }) => me(ctx, member.userId, member.deviceId, member.csrf));

  route(
    app,
    ctx,
    api.session.password,
    async ({ body, req, reply }) => {
      type Row = { id: string; password_hash: string; disabled: number };
      const username = body.username.trim().toLowerCase();
      const user = ctx.db.get<Row>("SELECT id, password_hash, disabled FROM users WHERE username = ?", username);
      // Always run scrypt so response time does not reveal which usernames exist.
      const valid = await checkPassword(
        ctx,
        req,
        { username, userId: user?.id ?? null },
        body.password,
        user?.password_hash ?? dummyPasswordHash(),
      );
      // Names nobody has share one entry an hour, so guessing can't fill the history.
      if (!user) recordHistory(ctx, { kind: "signin", username: null, reason: "password" }, null, "signin:unknown");
      else if (!valid)
        recordHistory(ctx, { kind: "signin", username, reason: "password" }, user.id, `signin:${user.id}:password`);
      if (!user || !valid) fail(401, "Incorrect username or password.");
      if (user.disabled) {
        recordHistory(ctx, { kind: "signin", username, reason: "suspended" }, user.id, `signin:${user.id}:suspended`);
        fail(403, "This account is disabled. Contact the administrator.");
      }
      const session = ctx.db.tx(() => {
        // The password may have changed while scrypt ran.
        if (ctx.db.value("SELECT password_hash FROM users WHERE id = ?", user.id) !== user.password_hash)
          fail(401, "Incorrect username or password.");
        return insertSession(ctx, user.id, newDevice(req, body), "password");
      });
      return finishSignIn(ctx, reply, session);
    },
    { rateLimit: SIGN_IN_LIMIT },
  );

  // Lets the join page show a dead end instead of a form. It reveals only what the link's holder
  // would learn by submitting: whether it still works, until when, and who sent it.
  route(
    app,
    ctx,
    api.session.invitation,
    ({ params }) => {
      const row = ctx.db.get<{ expires: number; invited_by: string }>(
        `SELECT i.expires, coalesce(u.display_name, u.username) AS invited_by FROM invites i JOIN users u ON u.id = i.created_by
         WHERE i.token_hash = ? AND i.used IS NULL AND i.expires > ?`,
        sha256(params.token),
        Date.now(),
      );
      return row ? { expires: row.expires, invitedBy: row.invited_by } : fail(410, INVITE_GONE);
    },
    { rateLimit: perAddress(20, "1 minute") },
  );

  route(
    app,
    ctx,
    api.session.join,
    async ({ body, req, reply }) => {
      // A dead invitation is turned away before the costly password hashing, so junk joins
      // can't crowd out everyone's sign-ins. It's checked again below, when it's taken.
      const invite = sha256(body.token);
      if (
        !ctx.db.get("SELECT 1 FROM invites WHERE token_hash = ? AND used IS NULL AND expires > ?", invite, Date.now())
      )
        fail(410, INVITE_GONE);
      const passwordHash = await hashPassword(body.password);
      const now = Date.now();
      const session = ctx.db.tx(() => {
        const used = ctx.db.run(
          "UPDATE invites SET used = ? WHERE token_hash = ? AND used IS NULL AND expires > ?",
          now,
          invite,
          now,
        );
        if (!used.changes) fail(410, INVITE_GONE);
        const { inviter, note, ...limits } = ctx.db.get<LimitRow & { inviter: string; note: string | null }>(
          `SELECT created_by AS inviter, note, ${LIMIT_COLUMNS} FROM invites WHERE token_hash = ?`,
          invite,
        )!;
        const userId = insertUser(ctx, { username: body.username, passwordHash, admin: false }, toLimits(limits), now);
        ctx.db.run("UPDATE invites SET used_by = ? WHERE token_hash = ?", userId, invite);
        ctx.activity.record(inviter, { kind: "joined", userId, username: body.username, note });
        recordHistory(
          ctx,
          { kind: "joined", username: body.username, via: "invitation", by: usernameOf(ctx, inviter) },
          userId,
        );
        return { inviter, ...insertSession(ctx, userId, newDevice(req, body), "invitation") };
      });
      // The inviting administrator sees the new member, and the invitation leaves the pending list.
      ctx.events.publish(session.inviter, "account");
      return finishSignIn(ctx, reply, session);
    },
    { rateLimit: SIGN_IN_LIMIT },
  );

  route(app, ctx, api.session.signOut, ({ member, reply }) => {
    ctx.db.run("DELETE FROM sessions WHERE token_hash = ?", member.sessionHash);
    clearCookie(ctx, reply, sessionCookie(ctx, reply.request));
    streamsOf(ctx).recheck();
    ctx.events.publish(member.userId, "devices");
    return { ok: true as const };
  });
}
