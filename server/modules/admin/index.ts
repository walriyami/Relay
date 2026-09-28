import type { FastifyInstance } from "fastify";
import { statfs } from "node:fs/promises";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import {
  DEFAULTS,
  NO_LIMITS,
  type AdminMember,
  type LimitsApplied,
  type MemberLimits,
  type PendingInvite,
} from "../../../shared/model.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { hashPassword, sha256 } from "../../lib/secrets.ts";
import {
  getPickupCode,
  issuePickupCode,
  codeLengthOf,
  preferredCodeLengthOf,
  reconcilePickupCodeMode,
  setPickupCodePreference,
} from "../../lib/pickup-codes.ts";
import { adminPickupProtectionOf } from "../../lib/pickup-code-guard.ts";
import { applyMemberLimits, LIMIT_COLUMNS, limitValues, toLimits, type LimitRow } from "../auth/member-limits.ts";
import { DAY_MS, storageFree, toUser, usageOf, USER_COLUMNS, type UserRow } from "../auth/sessions.ts";
import { streamsOf } from "../auth/streams.ts";
import { renameUser } from "../auth/users.ts";
import { limitsOf, setLimits } from "./settings.ts";

type MemberRow = UserRow & { disabled: number; created: number };
const MEMBER_COLUMNS = `${USER_COLUMNS}, disabled, created`;

function checkExpectedLimits(current: LimitRow, expected: MemberLimits | undefined) {
  if (!expected) fail(400, "Include the limits shown when you opened this editor.");
  if (limitValues(toLimits(current)).some((value, index) => value !== limitValues(expected)[index]))
    fail(409, "These limits changed while you were editing. Reopen the editor and review the current limits.");
}

export function registerAdmin(app: FastifyInstance, ctx: Context) {
  const member = (id: string) =>
    ctx.db.get<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM users WHERE id = ?`, id) ?? notFound("That member");

  route(app, ctx, api.admin.overview, async () => {
    reconcilePickupCodeMode(ctx);
    const free = storageFree(ctx);
    const members = ctx.db
      .all<MemberRow & { signed_in: number; last_active: number | null }>(
        `SELECT ${MEMBER_COLUMNS},
           (SELECT COUNT(DISTINCT device_id) FROM sessions s WHERE s.user_id = users.id AND s.expires > ?) AS signed_in,
           (SELECT max(seen) FROM devices d WHERE d.user_id = users.id) AS last_active
         FROM users ORDER BY created`,
        Date.now(),
      )
      .map((row): AdminMember => ({
        ...toUser(row),
        disabled: !!row.disabled,
        created: row.created,
        usage: usageOf(ctx, row.id, free),
        signedInDevices: row.signed_in,
        lastActive: row.last_active,
      }));
    const limits = limitsOf(ctx);
    const disk = await statfs(ctx.config.root);
    const hourAgo = Date.now() - 3_600_000;
    return {
      operations: ctx.operations.snapshot(),
      integrity: ctx.blobs.status(),
      usageBuffer: ctx.usage.status(),
      codeLength: preferredCodeLengthOf(ctx.db),
      codeProtection: adminPickupProtectionOf(ctx, codeLengthOf(ctx.db)),
      members,
      storage: {
        used: ctx.db.value<number>("SELECT ifnull(SUM(bytes_used), 0) FROM users")!,
        reserved: ctx.db.value<number>("SELECT ifnull(SUM(size), 0) FROM nodes WHERE state = 'pending'")!,
        capacity: limits.capacity,
        diskFree: disk.bavail * disk.bsize,
        diskTotal: disk.blocks * disk.bsize,
        blobBytes: ctx.db.value<number>("SELECT ifnull(SUM(size), 0) FROM blobs")!,
        // From trashed items to their nodes, so the cost follows Trash rather than the whole library.
        trashBytes: ctx.db.value<number>(
          "SELECT ifnull(SUM(n.size), 0) FROM items i CROSS JOIN nodes n ON n.item = i.id WHERE i.trashed IS NOT NULL AND n.state = 'ready'",
        )!,
        trashItems: ctx.db.value<number>("SELECT COUNT(*) FROM items WHERE trashed IS NOT NULL")!,
      },
      limits,
      activity: {
        activeUploads: ctx.transfers.activeUploads(),
        receivedBytesLastHour: ctx.transfers.receivedBytesSince(hourAgo),
      },
    };
  });

  route(app, ctx, api.admin.integrity, ({ body, member, reply }) => {
    // A single large blob can exceed a proxy request timeout. Start the bounded batch
    // here, then report completion through the ordinary administrator status channel.
    const check = ctx.blobs.scrub({ after: body.after });
    void check.then(
      () => ctx.events.publish(member.userId, "account"),
      (error: unknown) => {
        ctx.log.error({ err: error }, "storage integrity check failed");
        ctx.events.publish(member.userId, "account");
      },
    );
    reply.code(202);
    return ctx.blobs.status();
  });

  route(app, ctx, api.admin.invite, ({ member: admin, body }) => {
    reconcilePickupCodeMode(ctx);
    const now = Date.now();
    return ctx.db.tx(() => {
      const id = uuidv7(now);
      const token = ctx.secrets.inviteToken(id);
      const { code, codeHash } = issuePickupCode(ctx.db, ctx.secrets, "invitation", id);
      const expires = now + DEFAULTS.inviteDays * DAY_MS;
      ctx.db.run(
        `INSERT INTO invites(id, token_hash, code_hash, created_by, note, ${LIMIT_COLUMNS}, created, expires)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        sha256(token),
        codeHash,
        admin.userId,
        body.note || null,
        ...limitValues(body.limits ?? NO_LIMITS),
        now,
        expires,
      );
      return { token, code, expires };
    });
  });

  route(app, ctx, api.admin.invites, () => {
    reconcilePickupCodeMode(ctx);
    return ctx.db
      .all<
        LimitRow & {
          id: string;
          created: number;
          expires: number;
          created_by: string;
          note: string | null;
        }
      >(
        `SELECT i.id, i.created, i.expires, i.note, i.quota, i.max_retention_days, i.max_link_days,
           u.username AS created_by
         FROM invites i JOIN users u ON u.id = i.created_by
         WHERE i.used IS NULL AND i.expires > ? ORDER BY i.created DESC, i.rowid DESC`,
        Date.now(),
      )
      .map((row): PendingInvite => {
        return {
          id: row.id,
          created: row.created,
          expires: row.expires,
          createdBy: row.created_by,
          note: row.note,
          code: getPickupCode(ctx.db, ctx.secrets, "invitation", row.id) ?? "",
          limits: toLimits(row),
        };
      });
  });

  route(app, ctx, api.admin.updateInvite, ({ member: admin, params, body }) => {
    ctx.db.tx(() => {
      const invite =
        ctx.db.get<LimitRow>(
          `SELECT ${LIMIT_COLUMNS} FROM invites WHERE id = ? AND used IS NULL AND expires > ?`,
          params.id,
          Date.now(),
        ) ?? notFound("That invitation");
      if (body.limits) checkExpectedLimits(invite, body.expectedLimits);
      if (body.note !== undefined) ctx.db.run("UPDATE invites SET note = ? WHERE id = ?", body.note || null, params.id);
      if (body.limits)
        ctx.db.run(
          "UPDATE invites SET quota = ?, max_retention_days = ?, max_link_days = ? WHERE id = ?",
          ...limitValues(body.limits),
          params.id,
        );
    });
    ctx.events.publish(admin.userId, "account");
    return { ok: true as const };
  });

  route(app, ctx, api.admin.revokeInvite, ({ params }) => {
    if (!ctx.db.run("DELETE FROM invites WHERE id = ? AND used IS NULL", params.id).changes)
      notFound("That invitation");
    return { ok: true as const };
  });

  route(app, ctx, api.admin.updateMember, ({ params, body }) => {
    const target = member(params.id);
    if (target.admin && body.disabled) fail(409, "The administrator account cannot be disabled.");
    // An administrator could lift any limit of their own, so the account has none.
    if (target.admin && body.limits) fail(409, "The administrator account has no limits.");
    const { name, username, disabled, limits } = body;
    const applied = ctx.db.tx((): LimitsApplied => {
      if (limits) checkExpectedLimits(member(params.id), body.expectedLimits);
      if (name !== undefined)
        ctx.db.run("UPDATE users SET display_name = ? WHERE id = ?", name?.normalize("NFC") || null, target.id);
      if (username !== undefined && username !== target.username) renameUser(ctx, target.id, username);
      if (disabled !== undefined) {
        ctx.db.run("UPDATE users SET disabled = ? WHERE id = ?", disabled ? 1 : 0, target.id);
        if (disabled) ctx.db.run("DELETE FROM sessions WHERE user_id = ?", target.id);
      }
      return limits ? applyMemberLimits(ctx, target.id, limits, Date.now()) : { links: 0, items: 0, requests: 0 };
    });
    if (disabled) streamsOf(ctx).recheck();
    ctx.events.publish(
      target.id,
      "account",
      "devices",
      ...(applied.links ? (["links"] as const) : []),
      ...(applied.items ? (["items", "deliveries"] as const) : []),
      ...(applied.requests || applied.items ? (["requests"] as const) : []),
    );
    return applied;
  });

  route(app, ctx, api.admin.resetPassword, async ({ params, body }) => {
    const target = member(params.id);
    const hash = await hashPassword(body.password);
    ctx.db.tx(() => {
      ctx.db.run("UPDATE users SET password_hash = ? WHERE id = ?", hash, target.id);
      ctx.db.run("DELETE FROM passkeys WHERE user_id = ?", target.id);
      ctx.db.run("DELETE FROM sessions WHERE user_id = ?", target.id);
      ctx.activity.record(target.id, { kind: "password", device: null });
    });
    streamsOf(ctx).recheck({ userId: target.id, reason: "password-reset" });
    ctx.events.publish(target.id, "account", "devices");
    return { ok: true as const };
  });

  route(app, ctx, api.admin.settings, ({ body }) => {
    const { codeLength, capacity, expectedCapacity } = body;
    ctx.db.tx(() => {
      if (capacity !== undefined) {
        if (expectedCapacity === undefined) fail(400, "Include the capacity shown when you opened this editor.");
        if (expectedCapacity !== limitsOf(ctx).capacity)
          fail(409, "Capacity changed while you were editing. Reopen the editor and review the current capacity.");
      }
      if (codeLength !== undefined) setPickupCodePreference(ctx, codeLength);
      setLimits(ctx, { capacity });
    });
    return { ok: true as const };
  });
}
