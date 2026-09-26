import type { FastifyInstance } from "fastify";
import { statfs } from "node:fs/promises";
import type { Context } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import { DEFAULTS, type AdminMember, type PendingInvite } from "../../../shared/model.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { hashPassword, sha256 } from "../../lib/secrets.ts";
import { codeLengthOf, getPickupCode, issuePickupCode, rotatePickupCodes } from "../../lib/pickup-codes.ts";
import { DAY_MS, readPrefs, usageOf } from "../auth/sessions.ts";
import { streamsOf } from "../auth/streams.ts";
import { renameUser, setMemberValues } from "../auth/users.ts";
import { limitsOf, memberDefaultsOf, setLimits, setMemberDefaults } from "./settings.ts";

const MEMBER_COLUMNS = "id, username, display_name, admin, disabled, quota, retention_days, trash_days, prefs, created";

type MemberRow = {
  id: string;
  username: string;
  display_name: string | null;
  admin: number;
  disabled: number;
  quota: number;
  retention_days: number | null;
  trash_days: number;
  prefs: string;
  created: number;
};

export function registerAdmin(app: FastifyInstance, ctx: Context) {
  const member = (id: string) =>
    ctx.db.get<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM users WHERE id = ?`, id) ?? notFound("That member");

  route(app, ctx, api.admin.overview, async () => {
    const members = ctx.db
      .all<MemberRow & { signed_in: number }>(
        `SELECT ${MEMBER_COLUMNS},
           (SELECT COUNT(DISTINCT device_id) FROM sessions s WHERE s.user_id = users.id AND s.expires > ?) AS signed_in
         FROM users ORDER BY created`,
        Date.now(),
      )
      .map((row): AdminMember => ({
        id: row.id,
        username: row.username,
        name: row.display_name,
        admin: !!row.admin,
        quota: row.quota,
        retentionDays: row.retention_days,
        linkDays: readPrefs(row.prefs).linkDays,
        trashDays: row.trash_days,
        disabled: !!row.disabled,
        created: row.created,
        usage: usageOf(ctx, row.id),
        signedInDevices: row.signed_in,
      }));
    const limits = limitsOf(ctx);
    const disk = await statfs(ctx.config.root);
    const hourAgo = Date.now() - 3_600_000;
    return {
      operations: ctx.operations.snapshot(),
      codeLength: codeLengthOf(ctx.db),
      members,
      storage: {
        used: ctx.db.value<number>("SELECT ifnull(SUM(bytes_used), 0) FROM users")!,
        reserved: ctx.db.value<number>("SELECT ifnull(SUM(size), 0) FROM nodes WHERE state = 'pending'")!,
        capacity: limits.capacity,
        diskFree: disk.bavail * disk.bsize,
        diskTotal: disk.blocks * disk.bsize,
        blobBytes: ctx.db.value<number>("SELECT ifnull(SUM(size), 0) FROM blobs")!,
        trashBytes: ctx.db.value<number>(
          "SELECT ifnull(SUM(n.size), 0) FROM nodes n JOIN items i ON i.id = n.item WHERE i.trashed IS NOT NULL AND n.state = 'ready'",
        )!,
        trashItems: ctx.db.value<number>("SELECT COUNT(*) FROM items WHERE trashed IS NOT NULL")!,
      },
      limits,
      defaults: memberDefaultsOf(ctx),
      activity: {
        activeUploads: ctx.transfers.activeUploads(),
        receivedBytesLastHour: ctx.transfers.receivedBytesSince(hourAgo),
      },
    };
  });

  route(app, ctx, api.admin.invite, ({ member: admin, body }) => {
    const now = Date.now();
    return ctx.db.tx(() => {
      const id = uuidv7(now);
      const token = ctx.secrets.inviteToken(id);
      const { code, codeHash } = issuePickupCode(ctx.db, ctx.secrets, "invitation", id);
      const expires = now + DEFAULTS.inviteDays * DAY_MS;
      ctx.db.run(
        "INSERT INTO invites(id, token_hash, code_hash, created_by, note, created, expires) VALUES(?, ?, ?, ?, ?, ?, ?)",
        id,
        sha256(token),
        codeHash,
        admin.userId,
        body.note || null,
        now,
        expires,
      );
      return { token, code, expires };
    });
  });

  route(app, ctx, api.admin.invites, () =>
    ctx.db
      .all<{
        id: string;
        created: number;
        expires: number;
        created_by: string;
        note: string | null;
      }>(
        `SELECT i.id, i.created, i.expires, i.note, u.username AS created_by
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
        };
      }),
  );

  route(app, ctx, api.admin.revokeInvite, ({ params }) => {
    if (!ctx.db.run("DELETE FROM invites WHERE id = ? AND used IS NULL", params.id).changes)
      notFound("That invitation");
    return { ok: true as const };
  });

  route(app, ctx, api.admin.updateMember, ({ params, body }) => {
    const target = member(params.id);
    if (target.admin && body.disabled) fail(409, "The administrator account cannot be disabled.");
    const { name, username, disabled, ...values } = body;
    ctx.db.tx(() => {
      if (name !== undefined)
        ctx.db.run("UPDATE users SET display_name = ? WHERE id = ?", name?.normalize("NFC") || null, target.id);
      if (username !== undefined && username !== target.username) renameUser(ctx, target.id, username);
      setMemberValues(ctx, target.id, values);
      if (disabled !== undefined) {
        ctx.db.run("UPDATE users SET disabled = ? WHERE id = ?", disabled ? 1 : 0, target.id);
        if (disabled) ctx.db.run("DELETE FROM sessions WHERE user_id = ?", target.id);
      }
    });
    if (disabled) streamsOf(ctx).recheck();
    ctx.events.publish(target.id, "account", "devices");
    return { ok: true as const };
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
    const { codeLength, defaults, ...limits } = body;
    if (codeLength !== undefined) rotatePickupCodes(ctx, codeLength);
    setLimits(ctx, limits);
    if (defaults) setMemberDefaults(ctx, defaults);
    return { ok: true as const };
  });
}
