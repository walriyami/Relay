import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Destination, PausedTransfer, TransferCancelled, TransferResult } from "../../../shared/model.ts";
import { linkPasswordHash } from "../links/index.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { leaseRenewalMs, principalKey, type Context, type Principal } from "../../context.ts";
import { fail, HttpError, notFound } from "../../lib/errors.ts";
import { publishItemChange } from "./publish.ts";
import { assertTransferAvailability, ensureTransferAvailability, settleTransferAvailability } from "./availability.ts";
import { CANCELLED, TAB_CLOSED } from "./create.ts";
import { PROGRESS_STEP, isActive, uploadRow, type Receivers, type UploadRow } from "./receivers.ts";

import { DAY_MS } from "../../lib/time.ts";
import { recordHistory, usernameOf } from "../history/index.ts";

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
  authorize: () => void = () => {},
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
    for (const upload of arrived) await receivers.settle(upload.id, authorize);
  }
  ensureTransferAvailability(ctx, transfer);
  authorize();
  let result: TransferResult;
  try {
    result = ctx.db.tx(() => {
      const current = transferRow(ctx, transfer.id) ?? notFound("That transfer");
      assertTransferAvailability(ctx, current);
      if (current.state === "cancelled") fail(410, CANCELLED);
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
        recordFinished(ctx, current, principal, destination);
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

/** Adds a finished upload to the administrator's history: how many files and bytes, and where to. */
function recordFinished(ctx: Context, transfer: TransferRow, principal: Principal, destination: Destination) {
  const { files, bytes } = ctx.db.get<{ files: number; bytes: number }>(
    `SELECT count(*) AS files, ifnull(sum(n.size), 0) AS bytes
     FROM uploads u JOIN nodes n ON n.id = u.node WHERE u.transfer = ? AND n.state = 'ready'`,
    transfer.id,
  )!;
  const username = usernameOf(ctx, transfer.owner);
  if (principal.kind === "grant")
    return recordHistory(ctx, { kind: "received", username, files, bytes }, transfer.owner);
  const device =
    destination.kind === "device"
      ? (ctx.db.value<string>("SELECT name FROM devices WHERE id = ?", destination.device) ?? null)
      : null;
  const to = destination.kind === "save" ? "files" : destination.kind;
  recordHistory(ctx, { kind: "sent", username, to, device, files, bytes }, transfer.owner);
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
  // A member's unfinished uploads stay paused: the page may only have reloaded, and the next one
  // offers to continue them (see `paused`). A guest has no way back to a paused upload, and it
  // would hold the request's room, so a guest's page going away still cancels its uploads.
  for (const t of ctx.db.all<{ id: string }>(
    "SELECT id FROM transfers WHERE tab = ? AND state = 'open' AND principal LIKE 'grant:%'",
    tab,
  ))
    abandon(ctx, receivers, transferRow(ctx, t.id)!);
}

/**
 * How long an unfinished transfer may go without any of its files receiving bytes before its
 * reserved room is given back. Someone with a request link gets half an hour, so one visitor who
 * declares a large upload and sends nothing can't fill the request for everyone else; a member's
 * own transfer survives being paused for most of a day.
 */
export const STALLED_GUEST_MS = 30 * 60_000;
export const STALLED_MEMBER_MS = DAY_MS;

/**
 * How long a visitor's send may take to get going. A declared upload holds the request's room from
 * the start, so one that never really begins gives it back sooner than a stalled one, unless the
 * same visitor is busy sending something else (its turn may simply not have come yet). Getting going
 * means what counts as progress against a stall (`PROGRESS_STEP` arrived), so a byte or two doesn't
 * buy the full half hour; a send smaller than that holds little room and needs only to have begun.
 */
export const UNSTARTED_GUEST_MS = 10 * 60_000;

/**
 * How long a guest's upload stays paused once its page goes quiet (a phone that slept): as long as
 * a guest may go without sending bytes, since a quiet page sends none.
 */
export const GUEST_PAUSE_MS = STALLED_GUEST_MS;

/** When a tab was last seen: closed, or its lease (renewed while it is open) ran out. */
const LAST_SEEN = "min(b.lease_expires, coalesce(b.closed, b.lease_expires))";

/**
 * A member's unfinished transfers that no open page is sending: their page closed, reloaded or
 * slept past its lease. Each can be continued by choosing the same files again, until the sweep
 * removes it `pausedUploadMs` after its page was last seen.
 */
export async function paused(ctx: Context, receivers: Receivers, owner: string, ownTab: string | null) {
  const now = Date.now();
  const rows = ctx.db.all<{
    id: string;
    item: string;
    name: string | null;
    adding: number;
    seen: number;
    touched: number;
    text: number;
  }>(
    `SELECT t.id, t.item, coalesce(i.name, (SELECT name FROM nodes WHERE item = t.item AND parent IS NULL ORDER BY position LIMIT 1)) AS name, i.created != t.created AS adding,
       ${LAST_SEEN} AS seen, (SELECT max(u.touched) FROM uploads u WHERE u.transfer = t.id) AS touched,
       EXISTS (SELECT 1 FROM nodes WHERE item = t.item AND kind = 'text' AND created = t.created) AS text
     FROM transfers t JOIN tabs b ON b.id = t.tab JOIN items i ON i.id = t.item
     WHERE t.principal = ? AND t.state = 'open' AND t.tab != ? AND (b.closed IS NOT NULL OR b.lease_expires <= ?)
       AND i.trashed IS NULL
     ORDER BY t.created DESC LIMIT 10`,
    `user:${owner}`,
    ownTab ?? "",
    now,
  );
  const result: PausedTransfer[] = [];
  for (const row of rows) {
    const uploads = ctx.db.all<{
      id: string;
      node: string | null;
      size: number;
      offset: number;
      completed: number | null;
    }>("SELECT id, node, size, offset, completed FROM uploads WHERE transfer = ? ORDER BY rowid", row.id);
    const paths = nodePaths(ctx, row.item);
    const files: PausedTransfer["files"] = [];
    for (const upload of uploads) {
      // A file skipped earlier is no longer part of the transfer.
      if (upload.node === null && upload.completed === null) continue;
      const done = upload.completed !== null;
      files.push({
        upload: upload.id,
        path: (upload.node && paths.get(upload.node)) ?? "",
        size: upload.size,
        offset: done ? upload.size : upload.offset,
        done,
        ...(!done && upload.offset > 0 ? { sample: await receivers.sample(upload.id, upload.offset) } : {}),
      });
    }
    result.push({
      id: row.id,
      itemId: row.item,
      name: row.name ?? "",
      adding: !!row.adding,
      text: !!row.text,
      // Whichever comes first: the paused limit, or a day without any of its bytes arriving.
      keptUntil: Math.min(row.seen + ctx.config.pausedUploadMs, row.touched + STALLED_MEMBER_MS),
      files,
    });
  }
  return result;
}

/** Each node's path in an item, by id. */
function nodePaths(ctx: Context, item: string) {
  const nodes = ctx.db.all<{ id: string; parent: string | null; name: string }>(
    "SELECT id, parent, name FROM nodes WHERE item = ?",
    item,
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const paths = new Map<string, string>();
  const pathOf = (id: string): string => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id)!;
    const path = node.parent && byId.has(node.parent) ? `${pathOf(node.parent)}/${node.name}` : node.name;
    paths.set(id, path);
    return path;
  };
  for (const node of nodes) pathOf(node.id);
  return paths;
}

/**
 * Moves a paused transfer to the caller's page, which sends the rest of it. The page that started
 * it is closed, so it cannot send the same files at the same time.
 */
export function adopt(ctx: Context, transfer: TransferRow, principal: Principal, tab: string) {
  if (transfer.state === "cancelled") fail(410, CANCELLED);
  if (transfer.state === "complete") fail(409, "This transfer has already finished.");
  ctx.db.tx(() => {
    if (!renewTab(ctx, tab, principal)) fail(409, TAB_CLOSED);
    if (transfer.tab !== tab) {
      ctx.db.run("UPDATE tabs SET closed = ? WHERE id = ? AND closed IS NULL", Date.now(), transfer.tab);
      ctx.db.run("UPDATE transfers SET tab = ? WHERE id = ? AND state = 'open'", tab, transfer.id);
    }
  });
}

export async function sweep(ctx: Context, receivers: Receivers, now: number) {
  for (const t of ctx.db.all<{ id: string }>(
    `SELECT t.id FROM transfers t
     WHERE t.state = 'open'
       AND EXISTS (SELECT 1 FROM uploads u WHERE u.transfer = t.id AND u.completed IS NULL)
       AND (SELECT max(u.touched) FROM uploads u WHERE u.transfer = t.id)
           <= CASE WHEN t.principal LIKE 'grant:%' THEN ? ELSE ? END`,
    now - STALLED_GUEST_MS,
    now - STALLED_MEMBER_MS,
  )) {
    const uploads = ctx.db.all<{ id: string }>("SELECT id FROM uploads WHERE transfer = ?", t.id);
    if (uploads.some((upload) => receivers.receiving(upload.id))) continue;
    const transfer = transferRow(ctx, t.id);
    if (transfer?.state === "open") abandon(ctx, receivers, transfer);
  }

  for (const t of ctx.db.all<{ id: string; principal: string }>(
    `SELECT t.id, t.principal FROM transfers t JOIN uploads u ON u.transfer = t.id
     WHERE t.state = 'open' AND t.principal LIKE 'grant:%' AND t.created <= ?
       AND NOT EXISTS (SELECT 1 FROM transfers o JOIN uploads p ON p.transfer = o.id
                       WHERE o.principal = t.principal AND o.id != t.id AND o.state = 'open'
                         AND (p.offset > 0 OR p.completed IS NOT NULL) AND p.touched > ?)
     GROUP BY t.id
     HAVING sum(u.completed IS NULL) > 0
       AND (sum(CASE WHEN u.completed IS NULL THEN u.offset ELSE u.size END) = 0
            OR (sum(u.size) >= ? AND sum(CASE WHEN u.completed IS NULL THEN u.offset ELSE u.size END) < ?))`,
    now - UNSTARTED_GUEST_MS,
    now - UNSTARTED_GUEST_MS,
    PROGRESS_STEP,
    PROGRESS_STEP,
  )) {
    const busy = ctx.db.all<{ id: string }>(
      `SELECT u.id FROM transfers o JOIN uploads u ON u.transfer = o.id
       WHERE o.principal = ? AND o.state = 'open' AND u.completed IS NULL`,
      t.principal,
    );
    if (busy.some((upload) => receivers.receiving(upload.id))) continue;
    const transfer = transferRow(ctx, t.id);
    if (transfer?.state === "open") abandon(ctx, receivers, transfer);
  }

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
  // A page that slept, reloaded or closed leaves its uploads paused, not cancelled: they continue
  // when it wakes or the same files are chosen again. Only one gone this long gives them up. A
  // guest's pause is shorter: it holds the request's room, and a guest cannot find it after a reload.
  for (const t of ctx.db.all<{ id: string }>(
    `SELECT t.id FROM transfers t JOIN tabs b ON b.id = t.tab
     WHERE t.state = 'open' AND ${LAST_SEEN} <= (CASE WHEN t.principal LIKE 'grant:%' THEN ? ELSE ? END)`,
    now - Math.min(ctx.config.pausedUploadMs, GUEST_PAUSE_MS),
    now - ctx.config.pausedUploadMs,
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
