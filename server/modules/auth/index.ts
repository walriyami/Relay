// Accounts and sign-in: sessions, passwords, invitations, passkeys, login codes, devices and the
// event streams that make devices "online".
import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { registerAccount } from "./account.ts";
import { registerDevices } from "./devices.ts";
import { registerLoginCodes } from "./login-codes.ts";
import { challengesOf, registerPasskeys } from "./passkeys.ts";
import { registerSession } from "./session.ts";
import { registerStreams } from "./streams.ts";

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
