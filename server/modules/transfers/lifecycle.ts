import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Destination, TransferCancelled, TransferResult } from "../../../shared/model.ts";
import { linkPasswordHash } from "../links/index.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { leaseRenewalMs, principalKey, type Context, type Principal } from "../../context.ts";
import { fail, HttpError, notFound } from "../../lib/errors.ts";
import { publishItemChange } from "./publish.ts";
import { assertTransferAvailability, ensureTransferAvailability, settleTransferAvailability } from "./availability.ts";
import { isActive, uploadRow, type Receivers, type UploadRow } from "./receivers.ts";

import { DAY_MS } from "../../lib/time.ts";

type TransferRow = {
  id: string;
  principal: string;
  owner: string;
  item: string;
  tab: string;
  state: "open" | "complete" | "cancelled";
  result: string | null;
};
/** What a completed transfer did, stored so a retried complete returns the same result. */
/** A link password is never stored with the result: only that there was one. */
type StoredDestination =
  | Exclude<Destination, { kind: "link" }>
  | (Omit<Extract<Destination, { kind: "link" }>, "password"> & { password?: true });
type StoredResult = { destination: StoredDestination; link?: string; delivery?: string };
const stored = (destination: Destination): StoredDestination => {
  if (destination.kind !== "link") return destination;
  const { password, ...rest } = destination;
  return password ? { ...rest, password: true } : rest;
};

export const transferRow = (ctx: Context, id: string) =>
  ctx.db.get<TransferRow>("SELECT id, principal, owner, item, tab, state, result FROM transfers WHERE id = ?", id);

export function renewTab(ctx: Context, tab: string, principal: Principal): boolean {
  const key = principalKey(principal);
  const lease = Date.now() + ctx.config.tabLeaseMs;
  const row = ctx.db.get<{ principal: string; closed: number | null; lease_expires: number }>(
    "SELECT principal, closed, lease_expires FROM tabs WHERE id = ?",
    tab,
  );
  if (!row) {
    ctx.db.run("INSERT INTO tabs(id, principal, lease_expires) VALUES(?, ?, ?)", tab, key, lease);
    return true;
  }
  if (row.closed !== null || row.principal !== key) return false;
  // Every upload request renews its tab. Writing each time would commit (and fsync) twice per
  // request only to move the deadline by milliseconds, so a recent lease is left as it is.
  if (row.lease_expires <= lease - leaseRenewalMs(ctx))
    ctx.db.run("UPDATE tabs SET lease_expires = ? WHERE id = ?", lease, tab);
  return true;
}

/** Removes a transfer's unfinished uploads and marks it cancelled. Synchronous; keeps saved files. */
function cancelTransfer(ctx: Context, receivers: Receivers, transferId: string): number {
  return ctx.db.tx(() => {
    const unfinished = ctx.db.all<{ id: string }>(
      "SELECT id FROM uploads WHERE transfer = ? AND completed IS NULL AND node IS NOT NULL",
      transferId,
    );
    ctx.db.run(
      "DELETE FROM nodes WHERE state = 'pending' AND id IN (SELECT node FROM uploads WHERE transfer = ? AND completed IS NULL)",
      transferId,
    );
    ctx.db.run(
      "UPDATE transfers SET state = 'cancelled', finished = ? WHERE id = ? AND state = 'open'",
      Date.now(),
      transferId,
    );
    for (const upload of unfinished) ctx.db.afterCommit(() => receivers.discard(upload.id));
    return ctx.db.value<number>(
      "SELECT count(*) FROM uploads WHERE transfer = ? AND completed IS NOT NULL",
      transferId,
    )!;
  });
}

/**
 * Cancels a transfer on purpose (the user, a closed tab, an expired lease or a closed request).
 * An item left with no files or text that no other open transfer is filling is removed entirely.
 */
export function abandon(ctx: Context, receivers: Receivers, transfer: TransferRow): TransferCancelled {
  const saved = cancelTransfer(ctx, receivers, transfer.id);
  const unused = ctx.db.get(
    `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE item = ? AND kind != 'folder')
       AND NOT EXISTS (SELECT 1 FROM transfers WHERE item = ? AND state = 'open')
       AND NOT EXISTS (SELECT 1 FROM items WHERE id = ? AND first_saved_at IS NOT NULL)`,
    transfer.item,
    transfer.item,
    transfer.item,
  );
  publishItemChange(ctx, transfer.owner, transfer.item);
  if (unused) ctx.library.purge(transfer.item);
  return { saved, removed: !!unused };
}

export function cancelForItem(ctx: Context, receivers: Receivers, itemId: string, principal?: string) {
  const owner = ctx.db.value<string>("SELECT owner FROM items WHERE id = ?", itemId);
  for (const t of ctx.db.all<{ id: string }>(
    "SELECT id FROM transfers WHERE item = ? AND state = 'open' AND (? IS NULL OR principal = ?)",
    itemId,
    principal ?? null,
    principal ?? null,
  ))
    cancelTransfer(ctx, receivers, t.id);
  if (owner) publishItemChange(ctx, owner, itemId);
}

export function cancelForRequest(ctx: Context, receivers: Receivers, requestId: string) {
  for (const t of ctx.db.all<{ id: string }>(
    `SELECT t.id FROM transfers t JOIN items i ON i.id = t.item
     WHERE i.request_id = ? AND t.state = 'open' AND t.principal LIKE 'grant:%'`,
    requestId,
  ))
    abandon(ctx, receivers, transferRow(ctx, t.id)!);
}

/** A transfer the caller owns, else 404. */
export function ownTransfer(ctx: Context, principalOf: (key: string) => Principal | null, id: string) {
  const transfer = transferRow(ctx, id);
  if (transfer) settleTransferAvailability(ctx, transfer);
  const principal = transfer ? principalOf(transfer.principal) : null;
  if (!transfer || !principal) return notFound("That transfer");
  return { transfer, principal };
}

export function cancel(ctx: Context, receivers: Receivers, transfer: TransferRow): TransferCancelled {
  if (transfer.state === "complete") fail(409, "This transfer has already finished.");
  return abandon(ctx, receivers, transfer);
}

export async function complete(
  ctx: Context,
  receivers: Receivers,
  transfer: TransferRow,
  principal: Principal,
  destination: Destination,
): Promise<TransferResult> {
  ensureTransferAvailability(ctx, transfer);
  if (principal.kind === "grant" && destination.kind !== "save") fail(403, "Guests can only save files.");
  const passwordHash = destination.kind === "link" ? await linkPasswordHash(destination.password) : undefined;
  const settled = stored(destination);
  if (transfer.state === "open") {
    const arrived = ctx.db.all<{ id: string }>(
      "SELECT id FROM uploads WHERE transfer = ? AND completed IS NULL AND node IS NOT NULL AND offset = size",
      transfer.id,
    );
    for (const upload of arrived) await receivers.settle(upload.id);
  }
  ensureTransferAvailability(ctx, transfer);
  let result: TransferResult;
  try {
    result = ctx.db.tx(() => {
      const current = transferRow(ctx, transfer.id) ?? notFound("That transfer");
      assertTransferAvailability(ctx, current);
      if (current.state === "cancelled") fail(410, "This transfer was cancelled.");
      let saved: StoredResult;
      if (current.state === "complete") {
        saved = JSON.parse(current.result!) as StoredResult;
        if (JSON.stringify(saved.destination) !== JSON.stringify(settled))
          fail(409, "This transfer was already completed with another destination.");
      } else {
        if (
          ctx.db.get(
            "SELECT 1 FROM uploads WHERE transfer = ? AND completed IS NULL AND node IS NOT NULL LIMIT 1",
            current.id,
          )
        )
          fail(409, "Some files have not finished uploading.");
        ctx.library.owned(current.owner, current.item, { live: true });
        saved = {
          destination: settled,
          ...(destination.kind === "link" ? { link: uuidv7() } : {}),
          ...(destination.kind === "device" ? { delivery: uuidv7() } : {}),
        };
        ctx.db.run(
          "UPDATE transfers SET state = 'complete', finished = ?, result = ? WHERE id = ?",
          Date.now(),
          JSON.stringify(saved),
          current.id,
        );
        // A finished guest submission is what the owner's open tabs announce.
        if (principal.kind === "grant") {
          ctx.db.run(
            "UPDATE requests SET last_received = ? WHERE id = (SELECT request_id FROM items WHERE id = ?)",
            Date.now(),
            current.item,
          );
          recordSubmission(ctx, current);
        }
      }
      // Both creates are idempotent by id, so a retry returns the link or delivery made the first time.
      const link =
        destination.kind === "link"
          ? ctx.links.create(current.owner, {
              id: saved.link!,
              item: current.item,
              days: destination.days,
              passwordHash,
              visitorLimit: destination.visitorLimit,
              note: destination.note,
            })
          : null;
      const delivery =
        destination.kind === "device"
          ? ctx.deliveries.create(current.owner, principal.kind === "member" ? principal.deviceId : null, {
              id: saved.delivery!,
              item: current.item,
              device: destination.device,
            })
          : null;
      return { itemId: current.item, link, delivery };
    });
  } catch (error) {
    ensureTransferAvailability(ctx, transfer);
    throw error;
  }
  publishItemChange(ctx, transfer.owner, transfer.item);
  return result;
}

/**
 * Tells a request's owner what a guest just finished sending: the files of this transfer and
 * whether it carried text. Runs inside the completing transaction.
 */
function recordSubmission(ctx: Context, transfer: TransferRow) {
  const row = ctx.db.get<{ request_id: string; request: string; sender: string | null; created: number }>(
    `SELECT r.id AS request_id, r.name AS request, i.sender, t.created
     FROM transfers t JOIN items i ON i.id = t.item JOIN requests r ON r.id = i.request_id WHERE t.id = ?`,
    transfer.id,
  );
  if (!row) return;
  const files = ctx.db.get<{ count: number; bytes: number }>(
    `SELECT count(*) AS count, ifnull(sum(n.size), 0) AS bytes
     FROM uploads u JOIN nodes n ON n.id = u.node WHERE u.transfer = ? AND n.state = 'ready'`,
    transfer.id,
  )!;
  // A transfer's nodes are all created with it, text included.
  const text = !!ctx.db.get(
    "SELECT 1 FROM nodes WHERE item = ? AND kind = 'text' AND created = ?",
    transfer.item,
    row.created,
  );
  ctx.activity.record(transfer.owner, {
    kind: "upload",
    requestId: row.request_id,
    request: row.request,
    sender: row.sender,
    itemId: transfer.item,
    files: files.count,
    bytes: files.bytes,
    text,
  });
}

export function removeUpload(ctx: Context, receivers: Receivers, upload: UploadRow) {
  if (upload.state !== "open") fail(410, "This transfer is no longer open.");
  if (upload.completed !== null) fail(409, "This file has already been saved.");
  if (!isActive(upload)) return;
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM nodes WHERE id = ? AND state = 'pending'", upload.node);
    ctx.db.afterCommit(() => receivers.discard(upload.id));
  });
  publishItemChange(ctx, upload.owner, upload.item);
}

export function closeTab(
  ctx: Context,
  receivers: Receivers,
  principalOf: (key: string) => Principal | null,
  tab: string,
  caller: Principal,
) {
  const row = ctx.db.get<{ principal: string }>("SELECT principal FROM tabs WHERE id = ?", tab);
  if (!row) {
    ctx.db.run(
      "INSERT INTO tabs(id, principal, lease_expires, closed) VALUES(?, ?, ?, ?)",
      tab,
      principalKey(caller),
      Date.now(),
      Date.now(),
    );
    return;
  }
  if (!principalOf(row.principal)) return notFound("That tab");
  ctx.db.run("UPDATE tabs SET closed = ? WHERE id = ? AND closed IS NULL", Date.now(), tab);
  for (const t of ctx.db.all<{ id: string }>("SELECT id FROM transfers WHERE tab = ? AND state = 'open'", tab))
    abandon(ctx, receivers, transferRow(ctx, t.id)!);
}

export async function sweep(ctx: Context, receivers: Receivers, now: number) {
  // Request/grant expiry releases guest reservations even when no endpoint is visited. Member
  // appends to a saved submission have their own lifetime and remain valid after the request ends.
  for (const t of ctx.db.all<{ id: string }>(
    `SELECT t.id FROM transfers t
     LEFT JOIN guest_grants g ON g.token_hash = substr(t.principal, 7)
     LEFT JOIN requests r ON r.id = g.request_id
     WHERE t.state = 'open' AND t.principal LIKE 'grant:%'
       AND (g.token_hash IS NULL OR g.expires <= ? OR r.id IS NULL OR r.closed IS NOT NULL OR r.expires <= ?)`,
    now,
    now,
  )) {
    const transfer = transferRow(ctx, t.id);
    if (transfer?.state === "open") abandon(ctx, receivers, transfer);
  }
  for (const t of ctx.db.all<{ id: string }>(
    `SELECT t.id FROM transfers t JOIN tabs b ON b.id = t.tab
     WHERE t.state = 'open' AND (b.closed IS NOT NULL OR b.lease_expires <= ?)`,
    now,
  )) {
    const transfer = transferRow(ctx, t.id);
    if (transfer?.state === "open") abandon(ctx, receivers, transfer);
  }
  // A transfer can hold thousands of uploads, so they go first, in batches of their own.
  const finished = "SELECT id FROM transfers WHERE state != 'open' AND finished <= ?";
  await ctx.db.deleteBatched("uploads", `transfer IN (${finished})`, now - DAY_MS);
  await ctx.db.deleteBatched("transfers", "state != 'open' AND finished <= ?", now - DAY_MS);
  await ctx.db.deleteBatched(
    "tabs",
    "lease_expires <= ? AND NOT EXISTS (SELECT 1 FROM transfers WHERE tab = tabs.id)",
    now - DAY_MS,
  );
}

/** After a restart: drop part files nobody is uploading and resume the rest. */
export async function recover(ctx: Context, receivers: Receivers) {
  ctx.db.run(
    "UPDATE tabs SET lease_expires = max(lease_expires, ?) WHERE closed IS NULL",
    Date.now() + ctx.config.tabLeaseMs,
  );
  const active = ctx.db.all<UploadRow>(
    `SELECT u.id, u.transfer, u.node, u.size, u.offset, u.completed, t.owner, t.item, t.principal, t.tab, t.state
     FROM uploads u JOIN transfers t ON t.id = u.transfer
     WHERE u.completed IS NULL AND u.node IS NOT NULL AND t.state = 'open'`,
  );
  // A restart must not publish complete parts or retain reservations past their destination's lifetime.
  const viable = active.filter((upload) => {
    try {
      ensureTransferAvailability(ctx, upload);
      return true;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      // Suspended owners retain accepted bytes; the upload can resume after re-enabling.
      return uploadRow(ctx, upload.id)?.state === "open";
    }
  });
  const keep = new Set(viable.map((u) => `${u.id}.part`));
  const directory = join(ctx.config.root, "uploads");
  for (const name of await readdir(directory)) if (!keep.has(name)) await unlink(join(directory, name));
  for (const upload of viable) {
    try {
      assertTransferAvailability(ctx, upload);
      receivers.restore(upload);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      // Availability is checked again by HEAD/PATCH after a temporary owner suspension.
    }
  }
}
