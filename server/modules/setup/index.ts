// First start. Whoever opens Relay before anyone has an account creates the administrator, then
// makes their own choices and sets the total storage. Nothing has to be configured outside the browser,
// unless RELAY_SETUP_KEY asks for a one-time key from the server first.
import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import { NO_LIMITS, type SetupState } from "../../../shared/model.ts";
import { fail } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { hashPassword } from "../../lib/secrets.ts";
import { SIGN_IN_LIMIT } from "../auth/session.ts";
import { finishSignIn, insertSession, newDevice } from "../auth/sessions.ts";
import { insertUser } from "../auth/users.ts";
import { setLimits } from "../admin/settings.ts";
import { ensureSetupKey, hasSetupKey, removeSetupKey } from "./setup-key.ts";

const ALREADY_SET_UP = "Relay is already set up. Sign in to continue.";

/** Kept in `settings` under "setup" from the administrator's account until setup finishes. */
export function setupStateOf(ctx: Context): SetupState {
  if (!ctx.db.value("SELECT 1 FROM users LIMIT 1")) return "account";
  return ctx.db.setting("setup") === "choices" ? "choices" : "done";
}

export function registerSetup(app: FastifyInstance, ctx: Context) {
  if (ctx.config.setupKey && setupStateOf(ctx) === "account") ensureSetupKey(ctx.config.root);
  else removeSetupKey(ctx.config.root);

  route(app, ctx, api.setup.status, () => {
    const state = setupStateOf(ctx);
    return { state, keyRequired: ctx.config.setupKey && state === "account" };
  });

  route(
    app,
    ctx,
    api.setup.account,
    async ({ body, req, reply }) => {
      if (setupStateOf(ctx) !== "account") fail(409, ALREADY_SET_UP);
      if (ctx.config.setupKey && !hasSetupKey(ctx.config.root, body.setupKey ?? ""))
        fail(403, body.setupKey ? "The setup key is incorrect." : "Enter the setup key.");
      const passwordHash = await hashPassword(body.password);
      const now = Date.now();
      const session = ctx.db.tx(() => {
        // Checked again inside the transaction: two browsers may have got through scrypt together.
        if (setupStateOf(ctx) !== "account") fail(409, ALREADY_SET_UP);
        // The administrator can change any limit, so they have none.
        const userId = insertUser(ctx, { username: body.username, passwordHash, admin: true }, NO_LIMITS, now);
        ctx.db.setSetting("setup", "choices");
        return insertSession(ctx, userId, newDevice(req, body), "setup");
      });
      removeSetupKey(ctx.config.root);
      ctx.log.info({ username: body.username }, "administrator account created");
      return finishSignIn(ctx, reply, session);
    },
    { rateLimit: SIGN_IN_LIMIT },
  );

  // The administrator's own choices are saved like any member's, before this.
  route(app, ctx, api.setup.finish, ({ member, body }) => {
    ctx.db.tx(() => {
      if (setupStateOf(ctx) !== "choices") fail(409, "Relay is already set up.");
      setLimits(ctx, { capacity: body.capacity });
      ctx.db.run("DELETE FROM settings WHERE key = 'setup'");
    });
    ctx.events.publish(member.userId, "account");
    return { ok: true as const };
  });
}
