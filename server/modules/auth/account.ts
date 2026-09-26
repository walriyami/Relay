import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import { fail } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { hashPassword } from "../../lib/secrets.ts";
import { checkPassword } from "./passwords.ts";
import { readPrefs, toUser, USER_COLUMNS, type UserRow } from "./sessions.ts";
import { streamsOf } from "./streams.ts";

export function registerAccount(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.account.update, ({ member, body }) => {
    const user = ctx.db.tx(() => {
      if (body.name !== undefined)
        ctx.db.run(
          "UPDATE users SET display_name = ? WHERE id = ?",
          body.name?.normalize("NFC") || null,
          member.userId,
        );
      if (body.username !== undefined && body.username !== member.username) {
        const taken = ctx.db.get("SELECT 1 FROM users WHERE username = ? AND id != ?", body.username, member.userId);
        if (taken) fail(409, "That username is taken.");
        ctx.db.run("UPDATE users SET username = ? WHERE id = ?", body.username, member.userId);
      }
      if (body.retentionDays !== undefined)
        ctx.db.run("UPDATE users SET retention_days = ? WHERE id = ?", body.retentionDays, member.userId);
      if (body.prefs) {
        const current = readPrefs(ctx.db.value<string>("SELECT prefs FROM users WHERE id = ?", member.userId)!);
        const { activity, ...rest } = body.prefs;
        const defined = <T extends object>(patch: T) =>
          Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        const next = {
          ...current,
          ...defined(rest),
          activity: { ...current.activity, ...defined(activity ?? {}) },
        };
        ctx.db.run("UPDATE users SET prefs = ? WHERE id = ?", JSON.stringify(next), member.userId);
      }
      return ctx.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, member.userId)!;
    });
    // Activity preferences change what the feed returns. Every open tab shows the new name.
    ctx.events.publish(member.userId, "account", ...(body.prefs?.activity ? (["activity"] as const) : []));
    return { prefs: readPrefs(user.prefs), user: toUser(user) };
  });

  route(app, ctx, api.account.password, async ({ member, body }) => {
    const before = ctx.db.value<string>("SELECT password_hash FROM users WHERE id = ?", member.userId)!;
    if (!(await checkPassword(ctx, member.username, body.current, before))) fail(403, "Current password is incorrect.");
    const next = await hashPassword(body.password);
    // Password changes keep passkeys; the member can remove any they no longer trust in Settings.
    ctx.db.tx(() => {
      if (ctx.db.value("SELECT password_hash FROM users WHERE id = ?", member.userId) !== before)
        fail(409, "Your password was changed meanwhile. Sign in again and retry.");
      if (!ctx.db.get("SELECT 1 FROM sessions WHERE token_hash = ?", member.sessionHash))
        fail(401, "Sign in to continue.");
      ctx.db.run("UPDATE users SET password_hash = ? WHERE id = ?", next, member.userId);
      ctx.db.run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", member.userId, member.sessionHash);
      const device = ctx.db.value<string>("SELECT name FROM devices WHERE id = ?", member.deviceId)!;
      ctx.activity.record(member.userId, { kind: "password", device }, member.deviceId);
    });
    streamsOf(ctx).recheck({ userId: member.userId, reason: "password-changed" });
    ctx.events.publish(member.userId, "devices", "account");
    return { ok: true as const };
  });
}
