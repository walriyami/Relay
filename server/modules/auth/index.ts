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
export async function sweepAuth(ctx: Context, now: number) {
  challengesOf(ctx).sweep(now);
  await ctx.db.deleteBatched("sessions", "expires <= ?", now);
  // Used rows remain until their normal expiry so the issuing device can confirm which device
  // redeemed its code. Revoked and expired codes no longer need a status record.
  await ctx.db.deleteBatched("login_codes", "expires <= ?", now);
  await ctx.db.deleteBatched("login_codes", "revoked IS NOT NULL");
  await ctx.db.deleteBatched("invites", "expires <= ?", now);
  await ctx.db.deleteBatched("guest_grants", "expires <= ?", now);
  // Their guests go with them.
  await ctx.db.deleteBatched("nearby_invites", "expires <= ?", now);
}
