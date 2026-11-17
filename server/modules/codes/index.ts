import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import { fail, HttpError } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { normalizeCode } from "../../lib/secrets.ts";
import { checkAvailable, LINK_SELECT, type LinkRow } from "../links/service.ts";
import { checkCodeAttempt, recordCodeFailure } from "../../lib/pickup-code-guard.ts";
import { currentOwnedPickupCode, findPickupCode } from "../../lib/pickup-codes.ts";

/** One entry point classifies a code, then its recipient flow applies its own access rules. */
export function registerCodes(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.pickup.current, ({ body, member }) => {
    const current = currentOwnedPickupCode(ctx, member.userId, body.code);
    return current ? { code: current.code, expires: current.expires } : { code: null, expires: null };
  });

  route(app, ctx, api.pickup.resolve, ({ body, req }) => {
    const now = Date.now();
    const reject = (status: number, message: string): never => {
      recordCodeFailure(ctx, req.ip, now);
      fail(status, message);
    };
    checkCodeAttempt(ctx, req.ip, now);
    const code = normalizeCode(body.code);
    const codeHash = code ? ctx.secrets.pickupCodeHash(code) : "";
    const registered = code ? findPickupCode(ctx.db, codeHash, now) : undefined;
    if (!registered)
      return reject(404, "That code doesn’t match anything open. Codes stop working after a day; ask for a new one.");

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
