// What unfinished uploads hold of the server's capacity, an owner's storage limit and the disk.
//
// Everyone's upload holds its whole declared size against the owner's storage limit and a request's
// size limit. Against the server's capacity and the disk, a member's upload is admitted without
// counting what request-link visitors have declared but not sent: otherwise one stranger could
// declare a large file, send nothing, and stop everyone on the server from uploading. Visitors still
// count each other's in full. So a visitor's bytes are checked again as they arrive
// (`ensureVisitorRoom`), against everything stored, members' declared uploads and the bytes other
// visitors have sent or are sending right now; whoever's bytes no longer fit is the one refused.
import { statfsSync } from "node:fs";
import type { Context } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { capacityOf } from "../admin/settings.ts";
import { receiversOf } from "./receivers.ts";

export const DISK_HEADROOM = 256 * 1024 ** 2;
export const DISK_FULL = "The server's disk does not have enough free space for this transfer.";
export const CAPACITY_FULL = "The server has reached its storage capacity.";
export const RECIPIENT_FULL = "The recipient's storage is full.";

export function bytesLabel(bytes: number) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}

/**
 * The totals the held_* triggers keep on users (see schema.sql), summed over the members: a few rows
 * however many uploads are unfinished, so the checks below can run on every visitor's page view and
 * every MiB they send.
 */
function totals(ctx: Context) {
  return ctx.db.get<{
    stored: number;
    reserved: number;
    visitorUnsent: number;
    unsentMember: number;
    unsentVisitor: number;
  }>(
    `SELECT coalesce(sum(bytes_used), 0) AS stored, coalesce(sum(reserved_bytes), 0) AS reserved,
       coalesce(sum(reserved_visitor_unsent), 0) AS visitorUnsent,
       coalesce(sum(unsent_member), 0) AS unsentMember, coalesce(sum(unsent_visitor), 0) AS unsentVisitor
     FROM users`,
  )!;
}

/**
 * Bytes unfinished uploads will add to the server. Members' count in full. Visitors' count in full
 * when `visitors` is set; otherwise only as far as they've arrived, committed or streaming in now,
 * since bytes on their way don't show in the committed offset until their chunk is saved.
 */
export function heldBytes(ctx: Context, visitors: boolean, except?: string) {
  const sums = totals(ctx);
  if (visitors) return sums.reserved - (except ? ownHold(ctx, except, true) : 0);
  const held = sums.reserved - sums.visitorUnsent - (except ? ownHold(ctx, except, false) : 0);
  const arriving = receiversOf(ctx)?.arriving();
  if (!arriving?.size) return held;
  // Only the uploads streaming now are looked up, by id.
  const streaming = ctx.db.all<{ id: string }>(
    `SELECT u.id FROM json_each(?) j JOIN uploads u ON u.id = j.value JOIN nodes n ON n.id = u.node
     JOIN transfers t ON t.id = u.transfer
     WHERE n.state = 'pending' AND t.principal LIKE 'grant:%' AND u.id != ?`,
    JSON.stringify([...arriving.keys()]),
    except ?? "",
  );
  return streaming.reduce((sum, row) => sum + arriving.get(row.id)!, held);
}

/** What one upload's pending file adds to `heldBytes`: its size, or a visitor's sent bytes when `visitors` is off. */
function ownHold(ctx: Context, upload: string, visitors: boolean) {
  const row = ctx.db.get<{ size: number; offset: number; visitor: number }>(
    `SELECT n.size, u.offset, t.principal LIKE 'grant:%' AS visitor FROM uploads u
     JOIN nodes n ON n.id = u.node JOIN transfers t ON t.id = u.transfer WHERE u.id = ? AND n.state = 'pending'`,
    upload,
  );
  if (!row) return 0;
  return row.visitor && !visitors ? row.offset : row.size;
}

export const storedBytes = (ctx: Context) => totals(ctx).stored;

/** Bytes still to arrive in open transfers: everyone's, or members' only. */
export function outstandingBytes(ctx: Context, visitors: boolean) {
  const sums = totals(ctx);
  return sums.unsentMember + (visitors ? sums.unsentVisitor : 0);
}

/** What the server's capacity can still take, judged as for a visitor or for a member. */
export const capacityRoom = (ctx: Context, visitors: boolean) =>
  capacityOf(ctx) - storedBytes(ctx) - heldBytes(ctx, visitors);

/** Free disk space beyond Relay's headroom that unfinished uploads haven't claimed. */
export function diskRoom(ctx: Context, visitors: boolean) {
  const disk = statfsSync(ctx.config.root);
  return disk.bavail * disk.bsize - DISK_HEADROOM - ctx.transfers.outstandingBytes(visitors);
}

/** What the owner's storage limit still allows, every unfinished upload counted in full. */
export function quotaRoom(ctx: Context, owner: string) {
  const user = ctx.db.get<{ quota: number | null; bytes_used: number; reserved_bytes: number }>(
    "SELECT quota, bytes_used, reserved_bytes FROM users WHERE id = ?",
    owner,
  );
  if (!user || user.quota === null) return Infinity;
  return user.quota - user.bytes_used - user.reserved_bytes;
}

/**
 * How much a request-link visitor could send to `owner` now, apart from the request's own limit:
 * what a new visitor upload would be admitted against (see `admit` in create.ts).
 */
export const visitorStorageRoom = (ctx: Context, owner: string) =>
  Math.max(0, Math.min(quotaRoom(ctx, owner), capacityRoom(ctx, true), diskRoom(ctx, true)));

/**
 * Refuses the rest of a visitor's upload once the whole file no longer fits beside everything stored,
 * members' unfinished uploads and the bytes other visitors have sent, or the disk can't hold what is
 * still to arrive. Checked as the PATCH starts and again as its bytes arrive, so uploads that overlap
 * can't together go past the server's capacity.
 */
export function ensureVisitorRoom(ctx: Context, upload: { id: string; size: number; offset: number }) {
  if (storedBytes(ctx) + heldBytes(ctx, false, upload.id) + upload.size > capacityOf(ctx)) fail(507, CAPACITY_FULL);
  // The bytes of this request already written have already left the disk's free space.
  const arrived = receiversOf(ctx)?.arriving().get(upload.id) ?? 0;
  if (upload.size - upload.offset - arrived > diskRoom(ctx, false)) fail(507, DISK_FULL);
}
