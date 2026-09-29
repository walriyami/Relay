import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import { fail, HttpError } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { normalizeCode } from "../../lib/secrets.ts";
import { addressKey } from "../auth/limits.ts";
import { checkAvailable, LINK_SELECT, type LinkRow } from "../links/service.ts";
import { checkPickupCodeAttempt, pickupProtectionOf, recordPickupCodeFailure } from "../../lib/pickup-code-guard.ts";
import {
  codeLengthOf,
  currentOwnedPickupCode,
  ensurePickupCodeResolutionAvailable,
  reconcilePickupCodeMode,
  type PickupCodeKind,
} from "../../lib/pickup-codes.ts";

/** One entry point classifies a code, then its recipient flow applies its own access rules. */
export function registerCodes(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.pickup.config, ({ req }) => {
    const now = Date.now();
    reconcilePickupCodeMode(ctx, now);
    return {
      codeLength: codeLengthOf(ctx.db),
      protection: pickupProtectionOf(ctx, addressKey(req.ip), now),
    };
  });

  route(app, ctx, api.pickup.current, ({ body, member }) => {
    reconcilePickupCodeMode(ctx);
    const code = normalizeCode(body.code);
    const current = code ? currentOwnedPickupCode(ctx, member.userId, code) : null;
    return { code: current };
  });

  route(app, ctx, api.pickup.resolve, ({ body, req }) => {
    const address = addressKey(req.ip);
    const now = Date.now();
    reconcilePickupCodeMode(ctx, now);
    ensurePickupCodeResolutionAvailable(ctx.db);
    const reject = (status: number, message: string): never => {
      const outcome = recordPickupCodeFailure(ctx, address, now);
      if (outcome.addressTriggered || outcome.globalTriggered) reconcilePickupCodeMode(ctx, now);
      if (outcome.addressTriggered || outcome.globalTriggered)
        fail(429, "Too many incorrect codes. Code entry is temporarily paused.");
      fail(status, message);
    };
    checkPickupCodeAttempt(ctx, address, now);
    const code = normalizeCode(body.code, codeLengthOf(ctx.db));
    const codeHash = code ? ctx.secrets.pickupCodeHash(code) : "";
    const registered = code
      ? ctx.db.get<{ kind: PickupCodeKind; target_id: string }>(
          "SELECT kind, target_id FROM pickup_codes WHERE code_hash = ? AND retired IS NULL",
          codeHash,
        )
      : undefined;
    if (!registered) return reject(404, "That code does not match an available link.");

    switch (registered.kind) {
      case "share": {
        const link = ctx.db.get<LinkRow>(
          `${LINK_SELECT} WHERE l.id = ? AND l.code_hash = ?`,
          now,
          registered.target_id,
          codeHash,
        );
        let available: LinkRow;
        try {
          available = checkAvailable(link, now);
        } catch (error) {
          if (error instanceof HttpError) reject(error.status, error.message);
          throw error;
        }
        return { kind: "share" as const, path: `/s/${ctx.secrets.linkToken(available.id)}` };
      }
      case "request": {
        const request = ctx.db.get<{ id: string; closed: number | null; expires: number; owner_disabled: number }>(
          `SELECT r.id, r.closed, r.expires, u.disabled AS owner_disabled
             FROM requests r JOIN users u ON u.id = r.owner
             WHERE r.id = ? AND r.code_hash = ?`,
          registered.target_id,
          codeHash,
        );
        if (!request || request.closed !== null || request.expires <= now || request.owner_disabled)
          return reject(410, "This request is closed.");
        return { kind: "request" as const, path: `/r/${ctx.secrets.requestToken(request.id)}` };
      }
      case "invitation": {
        const invite = ctx.db.get<{ id: string; used: number | null; expires: number }>(
          "SELECT id, used, expires FROM invites WHERE id = ? AND code_hash = ?",
          registered.target_id,
          codeHash,
        );
        if (!invite || invite.used !== null || invite.expires <= now)
          return reject(410, "This invitation can’t be used.");
        return { kind: "invitation" as const, path: `/join/${ctx.secrets.inviteToken(invite.id)}` };
      }
      case "device": {
        const loginCode = ctx.db.get<{
          expires: number;
          used: number | null;
          revoked: number | null;
          session_expires: number;
          disabled: number;
        }>(
          `SELECT c.expires, c.used, c.revoked, s.expires AS session_expires, u.disabled
             FROM login_codes c JOIN sessions s ON s.token_hash = c.session_hash JOIN users u ON u.id = c.user_id
             WHERE c.id = ? AND c.code_hash = ?`,
          registered.target_id,
          codeHash,
        );
        if (
          !loginCode ||
          loginCode.expires <= now ||
          loginCode.used !== null ||
          loginCode.revoked !== null ||
          loginCode.session_expires <= now ||
          loginCode.disabled
        )
          return reject(410, "This sign-in code can’t be used.");
        return {
          kind: "device" as const,
          path: `/?device=${encodeURIComponent(ctx.secrets.deviceToken(registered.target_id))}`,
        };
      }
      case "nearby": {
        const invite = ctx.db.get<{ id: string; expires: number; disabled: number }>(
          `SELECT n.id, n.expires, u.disabled FROM nearby_invites n JOIN users u ON u.id = n.user_id
             WHERE n.id = ? AND n.code_hash = ?`,
          registered.target_id,
          codeHash,
        );
        if (!invite || invite.expires <= now || invite.disabled) return reject(410, "This Nearby code has ended.");
        return { kind: "nearby" as const, path: `/n/${ctx.secrets.nearbyToken(invite.id)}` };
      }
    }
  });
}
