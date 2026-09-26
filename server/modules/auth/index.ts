// Accounts and sign-in: sessions, passwords, invitations, passkeys, login codes, devices and the
// event streams that make devices "online".
import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { DEFAULTS, LIMITS } from "../../../shared/model.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { hashPassword } from "../../lib/secrets.ts";
import { registerAccount } from "./account.ts";
import { registerDevices } from "./devices.ts";
import { registerLoginCodes } from "./login-codes.ts";
import { challengesOf, registerPasskeys } from "./passkeys.ts";
import { registerSession } from "./session.ts";
import { registerStreams } from "./streams.ts";

/** Creates the first administrator, "admin", from the configured bootstrap password. */
export async function ensureAdmin(ctx: Context) {
  if (ctx.db.value("SELECT 1 FROM users LIMIT 1")) return;
  const password = ctx.config.adminPassword;
  if (!password || password.length < LIMITS.passwordMin)
    throw new Error(
      `Relay has no accounts yet: set RELAY_ADMIN_PASSWORD (at least ${LIMITS.passwordMin} characters) to create the administrator.`,
    );
  const hash = await hashPassword(password);
  ctx.db.run(
    "INSERT INTO users(id, username, password_hash, admin, quota, created) VALUES(?, 'admin', ?, 1, ?, ?)",
    uuidv7(),
    hash,
    DEFAULTS.quotaBytes,
    Date.now(),
  );
}

export function registerAuth(app: FastifyInstance, ctx: Context) {
  registerSession(app, ctx);
  registerAccount(app, ctx);
  registerPasskeys(app, ctx);
  registerLoginCodes(app, ctx);
  registerDevices(app, ctx);
  registerStreams(app, ctx);
}

/** Removes credentials that can no longer be used. Signed-out devices stay listed as history. */
export function sweepAuth(ctx: Context, now: number) {
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM sessions WHERE expires <= ?", now);
    // Used rows remain until their normal expiry so the issuing device can confirm which device
    // redeemed its code. Revoked and expired codes no longer need a status record.
    ctx.db.run("DELETE FROM login_codes WHERE expires <= ? OR revoked IS NOT NULL", now);
    ctx.db.run("DELETE FROM invites WHERE expires <= ?", now);
    ctx.db.run("DELETE FROM guest_grants WHERE expires <= ?", now);
  });
  challengesOf(ctx).sweep(now);
}
