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
  type MemberRemoval,
  type PendingInvite,
} from "../../../shared/model.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { stillActing } from "../../lib/auth.ts";
import { route } from "../../lib/http.ts";
import { localStatus } from "../local/index.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { hashPassword, sha256 } from "../../lib/secrets.ts";
import { countNewCode, issuePickupCode, livePickupCode } from "../../lib/pickup-codes.ts";
import { lastCodeAttackAt } from "../../lib/pickup-code-guard.ts";
import { applyMemberLimits, LIMIT_COLUMNS, limitValues, toLimits, type LimitRow } from "../auth/member-limits.ts";
import { DAY_MS, storageFree, toUser, usageOf, USER_COLUMNS, type UserRow } from "../auth/sessions.ts";
import { streamsOf } from "../auth/streams.ts";
import { renameUser } from "../auth/users.ts";
import { purge } from "../library/items.ts";
import { recordHistory, usernameOf } from "../history/index.ts";
import { limitsOf, setLimits } from "./settings.ts";
import { build } from "../../build-info.ts";

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
    const free = storageFree(ctx);
    const members = ctx.db
      .all<MemberRow & { signed_in: number; last_active: number | null; walriyami: number }>(
        `SELECT ${MEMBER_COLUMNS},
           (SELECT COUNT(DISTINCT device_id) FROM sessions s WHERE s.user_id = users.id AND s.expires > ?) AS signed_in,
           (SELECT max(seen) FROM devices d WHERE d.user_id = users.id) AS last_active,
           EXISTS(SELECT 1 FROM external_identities e WHERE e.user_id = users.id) AS walriyami
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
        walriyami: !!row.walriyami,
      }));
    const limits = limitsOf(ctx);
    const disk = await statfs(ctx.config.root);
    const hourAgo = Date.now() - 3_600_000;
    const integrity = ctx.blobs.status();
    return {
      operations: ctx.operations.snapshot(),
      integrity,
      usageBuffer: ctx.usage.status(),
      database: { failure: ctx.db.storageFailure },
      codeAttackAt: lastCodeAttackAt(ctx),
      members,
      storage: {
        used: ctx.db.value<number>("SELECT ifnull(SUM(bytes_used), 0) FROM users")!,
        reserved: ctx.db.value<number>("SELECT ifnull(SUM(size), 0) FROM nodes WHERE state = 'pending'")!,
        capacity: limits.capacity,
        diskFree: disk.bavail * disk.bsize,
        diskTotal: disk.blocks * disk.bsize,
        blobBytes: integrity.storedBytes,
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
      local: await localStatus(ctx),
      build,
    };
  });

  route(app, ctx, api.admin.integrity, ({ body, member, reply }) => {
    // A single large blob can exceed a proxy request timeout. Start the bounded batch
    // here, then report completion through the ordinary administrator status channel.
    const check = ctx.blobs.scrub({ after: body.after });
    void check.then(
      (result) => {
        const damaged = result.missing + result.corrupt + result.errors;
        if (damaged)
          recordHistory(ctx, {
            kind: "error",
            area: "stored files",
            detail: `The file check found ${damaged} missing or damaged ${damaged === 1 ? "file" : "files"}.`,
          });
        ctx.events.publish(member.userId, "account");
      },
      (error: unknown) => {
        ctx.log.error({ err: error }, "storage integrity check failed");
        recordHistory(
          ctx,
          { kind: "error", area: "the file check", detail: "It couldn’t finish; the server log has the details." },
          null,
          "integrity",
        );
        ctx.events.publish(member.userId, "account");
      },
    );
    reply.code(202);
    return ctx.blobs.status();
  });

  route(app, ctx, api.admin.invite, ({ member: admin, body }) => {
    const now = Date.now();
    return ctx.db.tx(() => {
      const id = uuidv7(now);
      const token = ctx.secrets.inviteToken(id);
      countNewCode(ctx, admin.userId, now);
      const { code, codeHash } = issuePickupCode(ctx.db, ctx.secrets, "invitation", id, now);
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
          code: livePickupCode(ctx, "invitation", row.id)?.code ?? "",
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

  const admins = () => ctx.db.value<number>("SELECT COUNT(*) FROM users WHERE admin = 1")!;
  const LAST_ADMIN = "Relay needs at least one administrator. Make someone else an administrator first.";

  route(app, ctx, api.admin.updateMember, ({ member: administrator, params, body }) => {
    const target = member(params.id);
    const { name, username, disabled, limits, admin } = body;
    // An administrator could lift their own limits or re-enable themselves, so an administrator
    // account is never limited or disabled. Remove the role first.
    const willBeAdmin = admin ?? !!target.admin;
    if (willBeAdmin && disabled)
      fail(409, "An administrator can't be disabled. Remove their administrator role first.");
    if (willBeAdmin && limits) fail(409, "Administrators have no limits.");
    if (admin && target.disabled && disabled !== false)
      fail(409, "Turn this account back on before making it an administrator.");
    const applied = ctx.db.tx((): LimitsApplied => {
      if (limits) checkExpectedLimits(member(params.id), body.expectedLimits);
      const by = usernameOf(ctx, administrator.userId);
      if (admin !== undefined && admin !== !!target.admin) {
        if (!admin && admins() <= 1) fail(409, LAST_ADMIN);
        recordHistory(ctx, { kind: "role", username: target.username, by, admin }, target.id);
        ctx.db.run(
          // Administrators have no limits; a member who loses the role starts with none too.
          "UPDATE users SET admin = ?, quota = NULL, max_retention_days = NULL, max_link_days = NULL WHERE id = ?",
          admin ? 1 : 0,
          target.id,
        );
      }
      if (name !== undefined)
        ctx.db.run("UPDATE users SET display_name = ? WHERE id = ?", name?.normalize("NFC") || null, target.id);
      if (username !== undefined && username !== target.username) renameUser(ctx, target.id, username);
      if (disabled !== undefined) {
        if (disabled !== !!target.disabled)
          recordHistory(ctx, { kind: disabled ? "suspended" : "restored", username: target.username, by }, target.id);
        ctx.db.run("UPDATE users SET disabled = ? WHERE id = ?", disabled ? 1 : 0, target.id);
        if (disabled) ctx.db.run("DELETE FROM sessions WHERE user_id = ?", target.id);
      }
      return limits ? applyMemberLimits(ctx, target.id, limits, Date.now()) : { links: 0, items: 0, requests: 0 };
    });
    if (disabled || admin === false) streamsOf(ctx).recheck();
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

  /** What removing a member deletes, so the confirmation can say it in numbers. */
  /** What removing a member deletes, counted now. */
  const removalOf = (target: { id: string }): MemberRemoval => {
    const now = Date.now();
    return {
      items: ctx.db.value<number>("SELECT COUNT(*) FROM items WHERE owner = ?", target.id)!,
      bytes:
        ctx.db.value<number>("SELECT bytes_used FROM users WHERE id = ?", target.id)! +
        ctx.db.value<number>(
          "SELECT ifnull(SUM(size), 0) FROM nodes WHERE owner = ? AND state = 'pending'",
          target.id,
        )!,
      links: ctx.db.value<number>(
        "SELECT COUNT(*) FROM links WHERE owner = ? AND revoked IS NULL AND (expires IS NULL OR expires > ?)",
        target.id,
        now,
      )!,
      requests: ctx.db.value<number>(
        "SELECT COUNT(*) FROM requests WHERE owner = ? AND closed IS NULL AND expires > ?",
        target.id,
        now,
      )!,
      devices: ctx.db.value<number>(
        "SELECT COUNT(DISTINCT device_id) FROM sessions WHERE user_id = ? AND expires > ?",
        target.id,
        now,
      )!,
    };
  };
  route(app, ctx, api.admin.removal, ({ params }) => removalOf(member(params.id)));

  /** Members whose removal is running, so a second click waits for the first instead of racing it. */
  const removing = new Set<string>();

  /**
   * Deletes the account and everything it owns: files (Trash too), links, requests, devices and
   * sessions. Each item goes through the library's purge so open transfers stop and stored bytes
   * are freed the same way as emptying Trash, one item at a time with other requests in between.
   * If an item can't be deleted, the account stays suspended with what's left, and removing it
   * again picks up where this stopped.
   */
  route(app, ctx, api.admin.removeMember, async ({ member: administrator, params, req }) => {
    const target = member(params.id);
    if (target.id === administrator.userId) fail(409, "You can't remove your own account.");
    if (target.admin && admins() <= 1) fail(409, LAST_ADMIN);
    if (removing.has(target.id)) fail(409, `${target.username} is already being removed.`);
    removing.add(target.id);
    try {
      const freed = removalOf(target);
      // Sign the member out first so nothing new arrives while their files are deleted. An
      // administrator also stops being one here, so a removal that stops part way never leaves a
      // suspended administrator counted as one, and two removals can't take the last two.
      ctx.db.tx(() => {
        if (target.admin && admins() <= 1) fail(409, LAST_ADMIN);
        ctx.db.run("UPDATE users SET disabled = 1, admin = 0 WHERE id = ?", target.id);
        ctx.db.run("DELETE FROM sessions WHERE user_id = ?", target.id);
      });
      streamsOf(ctx).recheck();
      for (const { id } of ctx.db.all<{ id: string }>("SELECT id FROM requests WHERE owner = ?", target.id))
        ctx.transfers.cancelForRequest(id);
      const suspended = () =>
        ctx.db.tx(() =>
          recordHistory(
            ctx,
            { kind: "suspended", username: target.username, by: usernameOf(ctx, administrator.userId) },
            target.id,
          ),
        );
      const failures: unknown[] = [];
      for (const { id } of ctx.db.all<{ id: string }>("SELECT id FROM items WHERE owner = ?", target.id)) {
        try {
          purge(ctx, id);
        } catch (error) {
          failures.push(error);
        }
        await new Promise((resolve) => setImmediate(resolve));
        // An administrator signed out or demoted meanwhile deletes nothing more; the member stays suspended.
        try {
          stillActing(ctx, req, administrator, "admin");
        } catch (error) {
          suspended();
          throw error;
        }
      }
      const by = usernameOf(ctx, administrator.userId);
      // No await from here on, so nothing can arrive between this count and the deletion.
      const left = ctx.db.value<number>("SELECT COUNT(*) FROM items WHERE owner = ?", target.id)!;
      if (left) {
        ctx.log.error(
          { err: failures[0], member: target.id, failed: failures.length, left },
          "member removal stopped: items could not be deleted",
        );
        suspended();
        fail(
          500,
          `${left === 1 ? "1 of their items" : `${left} of their items`} couldn’t be deleted, so ${target.username} ` +
            "is suspended but not removed yet. Try removing them again.",
        );
      }
      ctx.db.tx(() => {
        ctx.db.run("DELETE FROM users WHERE id = ?", target.id);
        recordHistory(ctx, { kind: "removed", username: target.username, by, items: freed.items, bytes: freed.bytes });
      });
    } finally {
      removing.delete(target.id);
      // Removed, or suspended with what's left: either way the members list has changed.
      ctx.events.broadcast("account");
    }
    ctx.log.info({ member: target.id, by: administrator.userId }, "member removed");
    return { ok: true as const };
  });

  route(app, ctx, api.admin.resetPassword, async ({ member: administrator, params, body, req }) => {
    const target = member(params.id);
    const hash = await hashPassword(body.password);
    ctx.db.tx(() => {
      stillActing(ctx, req, administrator, "admin");
      ctx.db.run("UPDATE users SET password_hash = ? WHERE id = ?", hash, target.id);
      ctx.db.run("DELETE FROM passkeys WHERE user_id = ?", target.id);
      ctx.db.run("DELETE FROM sessions WHERE user_id = ?", target.id);
      ctx.activity.record(target.id, { kind: "password", device: null });
      recordHistory(
        ctx,
        { kind: "password", username: target.username, by: usernameOf(ctx, administrator.userId) },
        target.id,
      );
    });
    streamsOf(ctx).recheck({ userId: target.id, reason: "password-reset" });
    ctx.events.publish(target.id, "account", "devices");
    return { ok: true as const };
  });

  route(app, ctx, api.admin.settings, ({ body }) => {
    const { capacity, expectedCapacity } = body;
    ctx.db.tx(() => {
      if (capacity !== undefined) {
        if (expectedCapacity === undefined) fail(400, "Include the capacity shown when you opened this editor.");
        if (expectedCapacity !== limitsOf(ctx).capacity)
          fail(409, "Capacity changed while you were editing. Reopen the editor and review the current capacity.");
      }
      setLimits(ctx, { capacity });
    });
    return { ok: true as const };
  });
}
