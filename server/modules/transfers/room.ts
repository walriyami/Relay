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
 * Bytes unfinished uploads will add to the server. Members' count in full. Visitors' count in full
 * when `visitors` is set; otherwise only as far as they've arrived, committed or streaming in now,
 * since bytes on their way don't show in the committed offset until their chunk is saved.
 */
export function heldBytes(ctx: Context, visitors: boolean, except?: string) {
  const from = `FROM nodes n LEFT JOIN uploads u ON u.node = n.id LEFT JOIN transfers t ON t.id = u.transfer
    WHERE n.state = 'pending' AND (u.id IS NULL OR u.id != ?)`;
  const promised = visitors ? "n.size" : "u.offset";
  const held = ctx.db.value<number>(
    `SELECT coalesce(sum(CASE WHEN t.principal LIKE 'grant:%' THEN ${promised} ELSE n.size END), 0) ${from}`,
    except ?? "",
  )!;
  const arriving = visitors ? undefined : receiversOf(ctx)?.arriving();
  if (!arriving?.size) return held;
  const streaming = ctx.db.all<{ id: string }>(
    `SELECT u.id ${from} AND t.principal LIKE 'grant:%' AND u.id IN (SELECT value FROM json_each(?))`,
    except ?? "",
    JSON.stringify([...arriving.keys()]),
  );
  return streaming.reduce((sum, row) => sum + arriving.get(row.id)!, held);
}

export const storedBytes = (ctx: Context) => ctx.db.value<number>("SELECT coalesce(sum(bytes_used), 0) FROM users")!;

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
  const user = ctx.db.get<{ quota: number | null; bytes_used: number }>(
    "SELECT quota, bytes_used FROM users WHERE id = ?",
    owner,
  );
  if (!user || user.quota === null) return Infinity;
  const reserved = ctx.db.value<number>(
    "SELECT coalesce(sum(size), 0) FROM nodes WHERE state = 'pending' AND owner = ?",
    owner,
  )!;
  return user.quota - user.bytes_used - reserved;
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
