import type { FastifyInstance } from "fastify";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import { DEFAULTS, type LoginCode } from "../../../shared/model.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { normalizeCode, sha256 } from "../../lib/secrets.ts";
import { issuePickupCode } from "../../lib/pickup-codes.ts";
import { finishSignIn, insertSession } from "./sessions.ts";
import { addressKey, perAddress } from "./limits.ts";
import { memberFromToken, sessionCookie } from "../../lib/auth.ts";
import { checkPickupCodeAttempt, recordPickupCodeFailure } from "../../lib/pickup-code-guard.ts";
import { codeLengthOf } from "../../lib/pickup-codes.ts";

const CODE_MS = DEFAULTS.loginCodeMinutes * 60_000;
const invalid = () =>
  fail(410, "This sign-in code is invalid, expired or already used. Create a new one on your signed-in device.");

type RedeemableLoginCode = { id: string; user_id: string };
function redeemLoginCode(ctx: Context, deviceName: string, lookup: (now: number) => RedeemableLoginCode | undefined) {
  return ctx.db.tx(() => {
    const now = Date.now();
    const row = lookup(now) ?? invalid();
    const session = insertSession(ctx, row.user_id, deviceName, "code");
    const used = ctx.db.run(
      "UPDATE login_codes SET used = ?, used_device_id = ? WHERE id = ? AND used IS NULL AND revoked IS NULL",
      now,
      session.deviceId,
      row.id,
    );
    if (!used.changes) invalid();
    return session;
  });
}

/**
 * Codes let a signed-in browser admit a new one. Each code is bound to the session that issued it
 * (the foreign key removes it when that session ends), and issuing a new code retires the previous one.
 */
export function registerLoginCodes(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.loginCodes.list, ({ member }) => {
    const now = Date.now();
    return ctx.db.all<LoginCode>(
      `SELECT c.id, c.created, c.expires, d.name AS deviceName
       FROM login_codes c JOIN sessions s ON s.token_hash = c.session_hash JOIN devices d ON d.id = s.device_id
       WHERE c.user_id = ? AND c.used IS NULL AND c.revoked IS NULL AND c.expires > ?
       ORDER BY c.created DESC`,
      member.userId,
      now,
    );
  });

  route(app, ctx, api.loginCodes.status, ({ member, params }) => {
    const now = Date.now();
    const row = ctx.db.get<{
      expires: number;
      used: number | null;
      revoked: number | null;
      session_expires: number | null;
      device_name: string | null;
    }>(
      `SELECT c.expires, c.used, c.revoked, s.expires AS session_expires, d.name AS device_name
       FROM login_codes c
       LEFT JOIN sessions s ON s.token_hash = c.session_hash
       LEFT JOIN devices d ON d.id = c.used_device_id
       WHERE c.id = ? AND c.user_id = ?`,
      params.id,
      member.userId,
    );
    if (
      !row ||
      row.expires <= now ||
      row.revoked !== null ||
      row.session_expires === null ||
      row.session_expires <= now
    )
      return { state: "gone" as const };
    if (row.used !== null)
      return row.device_name ? { state: "used" as const, deviceName: row.device_name } : { state: "used" as const };
    return { state: "pending" as const };
  });

  route(
    app,
    ctx,
    api.loginCodes.create,
    ({ member }) => {
      const now = Date.now();
      const id = uuidv7(now);
      const issued = ctx.db.tx(() => {
        ctx.db.run(
          "UPDATE login_codes SET revoked = ? WHERE session_hash = ? AND used IS NULL AND revoked IS NULL",
          now,
          member.sessionHash,
        );
        const pickup = issuePickupCode(ctx.db, ctx.secrets, "device", id);
        const token = ctx.secrets.deviceToken(id);
        ctx.db.run(
          `INSERT INTO login_codes(id, user_id, session_hash, code_hash, created, expires, device_token_hash)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
          id,
          member.userId,
          member.sessionHash,
          pickup.codeHash,
          now,
          now + CODE_MS,
          sha256(token),
        );
        return { code: pickup.code, token };
      });
      ctx.events.publish(member.userId, "devices");
      return { id, ...issued, expires: now + CODE_MS, expiresIn: CODE_MS };
    },
    // Per signed-in account rather than per address: reopening Add a device makes a new code each
    // time, and people behind one address (a household, an office) must not use up each other's.
    {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        keyGenerator: (req) => {
          const member = memberFromToken(ctx, req.cookies?.[sessionCookie(ctx, req)]);
          return member ? `login-code:${member.userId}` : addressKey(req.ip);
        },
      },
    },
  );

  route(app, ctx, api.loginCodes.revoke, ({ member, params }) => {
    const revoked = ctx.db.run(
      "UPDATE login_codes SET revoked = ifnull(revoked, ?) WHERE id = ? AND user_id = ?",
      Date.now(),
      params.id,
      member.userId,
    );
    if (!revoked.changes) notFound("That sign-in code");
    ctx.events.publish(member.userId, "devices");
    return { ok: true as const };
  });

  route(
    app,
    ctx,
    api.session.code,
    ({ body, reply, req }) => {
      const address = addressKey(req.ip);
      const now = Date.now();
      checkPickupCodeAttempt(ctx, address, now);
      const reject = (): never => {
        recordPickupCodeFailure(ctx, address, now);
        return invalid();
      };
      const code = normalizeCode(body.code, codeLengthOf(ctx.db)) ?? reject();
      const session = redeemLoginCode(
        ctx,
        body.deviceName,
        (time) =>
          ctx.db.get<RedeemableLoginCode>(
            `SELECT c.id, c.user_id FROM login_codes c
           JOIN sessions s ON s.token_hash = c.session_hash JOIN users u ON u.id = c.user_id
           JOIN pickup_codes p ON p.code_hash = c.code_hash AND p.kind = 'device'
           AND p.target_id = c.id AND p.retired IS NULL
           WHERE c.code_hash = ? AND c.expires > ? AND c.used IS NULL AND c.revoked IS NULL
             AND s.expires > ? AND u.disabled = 0`,
            ctx.secrets.pickupCodeHash(code),
            time,
            time,
          ) ?? reject(),
      );
      return finishSignIn(ctx, reply, session);
    },
    { rateLimit: perAddress(10, "1 minute") },
  );

  route(
    app,
    ctx,
    api.session.deviceLinkCheck,
    ({ params }) => {
      const now = Date.now();
      const row = ctx.db.get<{ expires: number }>(
        `SELECT c.expires FROM login_codes c
         JOIN sessions s ON s.token_hash = c.session_hash JOIN users u ON u.id = c.user_id
         JOIN pickup_codes p ON p.code_hash = c.code_hash AND p.kind = 'device'
           AND p.target_id = c.id AND p.retired IS NULL
         WHERE c.device_token_hash = ? AND c.expires > ? AND c.used IS NULL AND c.revoked IS NULL
           AND s.expires > ? AND u.disabled = 0`,
        sha256(params.token),
        now,
        now,
      );
      return row ? { expires: row.expires } : invalid();
    },
    { rateLimit: perAddress(20, "1 minute") },
  );

  route(
    app,
    ctx,
    api.session.deviceLink,
    ({ body, reply }) => {
      const tokenHash = sha256(body.token);
      const session = redeemLoginCode(ctx, body.deviceName, (now) =>
        ctx.db.get<RedeemableLoginCode>(
          `SELECT c.id, c.user_id FROM login_codes c
           JOIN sessions s ON s.token_hash = c.session_hash JOIN users u ON u.id = c.user_id
           JOIN pickup_codes p ON p.code_hash = c.code_hash AND p.kind = 'device'
             AND p.target_id = c.id AND p.retired IS NULL
           WHERE c.device_token_hash = ? AND c.expires > ? AND c.used IS NULL AND c.revoked IS NULL
             AND s.expires > ? AND u.disabled = 0`,
          tokenHash,
          now,
          now,
        ),
      );
      return finishSignIn(ctx, reply, session);
    },
    { rateLimit: perAddress(10, "1 minute") },
  );
}
