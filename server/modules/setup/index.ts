// First start. Whoever opens Relay before anyone has an account creates the administrator, then
// chooses what members get. Nothing has to be configured outside the browser.
import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import type { SetupState } from "../../../shared/model.ts";
import { fail } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { hashPassword } from "../../lib/secrets.ts";
import { SIGN_IN_LIMIT } from "../auth/session.ts";
import { DEFAULT_DEVICE_NAME, finishSignIn, insertSession } from "../auth/sessions.ts";
import { insertUser, setMemberValues } from "../auth/users.ts";
import { memberDefaultsOf, setLimits, setMemberDefaults } from "../admin/settings.ts";

const ALREADY_SET_UP = "Relay is already set up. Sign in to continue.";

/** Kept in `settings` under "setup" from the administrator's account until setup finishes. */
export function setupStateOf(ctx: Context): SetupState {
  if (!ctx.db.value("SELECT 1 FROM users LIMIT 1")) return "account";
  return ctx.db.setting("setup") === "defaults" ? "defaults" : "done";
}

export function registerSetup(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.setup.status, () => ({ state: setupStateOf(ctx) }));

  route(
    app,
    ctx,
    api.setup.account,
    async ({ body, reply }) => {
      if (setupStateOf(ctx) !== "account") fail(409, ALREADY_SET_UP);
      const passwordHash = await hashPassword(body.password);
      const now = Date.now();
      const session = ctx.db.tx(() => {
        // Checked again inside the transaction: two browsers may have got through scrypt together.
        if (setupStateOf(ctx) !== "account") fail(409, ALREADY_SET_UP);
        const userId = insertUser(
          ctx,
          { username: body.username, passwordHash, admin: true },
          memberDefaultsOf(ctx),
          now,
        );
        ctx.db.setSetting("setup", "defaults");
        return insertSession(ctx, userId, body.deviceName ?? DEFAULT_DEVICE_NAME, "setup");
      });
      ctx.log.info({ username: body.username }, "administrator account created");
      return finishSignIn(ctx, reply, session);
    },
    { rateLimit: SIGN_IN_LIMIT },
  );

  route(app, ctx, api.setup.finish, ({ member, body }) => {
    const { capacity, ...values } = body;
    ctx.db.tx(() => {
      if (setupStateOf(ctx) !== "defaults") fail(409, "Relay is already set up.");
      setMemberDefaults(ctx, values);
      setLimits(ctx, { capacity });
      // The administrator is a member too, and starts with the same.
      setMemberValues(ctx, member.userId, values);
      ctx.db.run("DELETE FROM settings WHERE key = 'setup'");
    });
    ctx.events.publish(member.userId, "account");
    return { ok: true as const };
  });
}
