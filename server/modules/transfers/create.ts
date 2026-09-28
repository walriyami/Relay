// POST /api/transfers: one synchronous transaction checks every limit, creates (or appends to) the
// item, its folders, the text node, a pending node and an upload row per file. Zero-byte files are
// completed on the spot. Retrying the same id with the same manifest returns the same result.
import { statfsSync } from "node:fs";
import { LIMITS, type TransferCreated } from "../../../shared/model.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { principalKey, type Context, type CreateTransferOptions, type TransferInput } from "../../context.ts";
import { isUniqueViolation } from "../../db/database.ts";
import { fail } from "../../lib/errors.ts";
import { cleanName } from "../../lib/names.ts";
import { sha256 } from "../../lib/secrets.ts";
import { EMPTY_SHA256 } from "../../storage/blobs.ts";
import { capacityOf } from "../admin/settings.ts";
import { allowedKeepDays } from "../auth/member-limits.ts";
import { foldCase, planNodes, type PlannedNode } from "./plan.ts";
import { publishItemChange } from "./publish.ts";
import { startRetention } from "../library/retention.ts";
import { assertTransferAvailability, ensureTransferAvailability } from "./availability.ts";

const DISK_HEADROOM = 256 * 1024 ** 2;
export const TAB_CLOSED = "This tab was closed, so its transfer was cancelled.";
const NAME_TAKEN = "A file or folder with that name already exists there.";

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

/** The request's room, the owner's quota, service capacity and free disk space must all hold the new bytes. */
function admit(ctx: Context, options: CreateTransferOptions, bytes: number, entries: number) {
  if (options.limit) {
    const room = options.limit;
    if ((bytes > 0 && room.bytes === 0) || room.entries === 0) fail(413, "This request is full.");
    if (bytes > room.bytes) fail(413, `This request has room for ${bytesLabel(room.bytes)} more.`);
    if (entries > room.entries) fail(413, "This request cannot take that many more files.");
  }

  const reserved = (where: string, ...args: string[]) =>
    ctx.db.value<number>(`SELECT coalesce(sum(size), 0) FROM nodes WHERE state = 'pending' ${where}`, ...args)!;
  const user = ctx.db.get<{ quota: number | null; bytes_used: number }>(
    "SELECT quota, bytes_used FROM users WHERE id = ?",
    options.owner,
  )!;
  if (
    bytes > 0 &&
    user.quota !== null &&
    user.bytes_used + reserved("AND owner = ?", options.owner) + bytes > user.quota
  )
    fail(
      413,
      options.principal.kind === "grant"
        ? "The recipient's storage is full."
        : "This would go over your storage limit. Free up space, or ask your administrator for more.",
    );
  const capacity = capacityOf(ctx);
  const stored = ctx.db.value<number>("SELECT coalesce(sum(bytes_used), 0) FROM users")!;
  if (bytes > 0 && stored + reserved("") + bytes > capacity) fail(507, "The server has reached its storage capacity.");
  const disk = statfsSync(ctx.config.root);
  if (bytes > 0 && disk.bavail * disk.bsize - ctx.transfers.outstandingBytes() - DISK_HEADROOM < bytes)
    fail(507, "The server's disk does not have enough free space for this transfer.");
}

/** "Text.txt", or "Text (2).txt" and so on when that name is taken at the top level. */
function textName(taken: Set<string>) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? "Text.txt" : `Text (${n}).txt`;
    if (!taken.has(foldCase(name))) return name;
  }
}

/** Add a suffix before the extension until a sibling name is available. */
function uniqueName(name: string, taken: Set<string>, preserveExtension = false) {
  if (!taken.has(foldCase(name))) return name;
  const dot = preserveExtension ? name.lastIndexOf(".") : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    let boundedStem = stem;
    while (
      boundedStem &&
      (`${boundedStem}${suffix}${extension}`.length > LIMITS.nameLength ||
        Buffer.byteLength(`${boundedStem}${suffix}${extension}`) > 255)
    )
      boundedStem = [...boundedStem].slice(0, -1).join("");
    const candidate = `${boundedStem}${suffix}${extension}`;
    if (!taken.has(foldCase(candidate))) return candidate;
  }
}

export function createTransfer(ctx: Context, input: TransferInput, options: CreateTransferOptions): TransferCreated {
  if (ctx.db.sqlite.isTransaction) throw new Error("Transfers must be created outside an existing transaction.");
  const principal = principalKey(options.principal);
  const target = { owner: options.owner, principal, ...(options.itemId ? { item: options.itemId } : {}) };
  ensureTransferAvailability(ctx, target);
  // itemId and itemName are derived server-side for guest retries. Only the request itself,
  // stable principal and request identity define an idempotent create.
  const requestHash = sha256(JSON.stringify([input, principal, options.requestId ?? null]));
  const uploadsInOrder = (plan: PlannedNode[], ids: string[]) => {
    const paths = plan.filter((n) => n.file !== undefined).sort((a, b) => a.file! - b.file!);
    return ids.map((id, i) => ({ id, path: paths[i].path }));
  };

  let emptyPrepared = false;

  try {
    // Retry lookup precedes planning, admission, and filesystem preparation. This keeps a guest
    // retry idempotent after its grant has acquired the submission itemId.
    const initial = ctx.db.get<{ principal: string; request_hash: string; item: string; state: string }>(
      "SELECT principal, request_hash, item, state FROM transfers WHERE id = ?",
      input.id,
    );
    if (initial) {
      if (initial.principal !== principal || initial.request_hash !== requestHash)
        fail(409, "This transfer was already created with different contents.");
      ensureTransferAvailability(ctx, { ...target, item: initial.item });
      if (initial.state === "cancelled") fail(410, "This transfer was cancelled.");
      const plan = planNodes(input);
      const ids = ctx.db.all<{ id: string }>("SELECT id FROM uploads WHERE transfer = ? ORDER BY rowid", input.id);
      if (options.sender != null)
        ctx.db.run("UPDATE items SET sender = coalesce(sender, ?) WHERE id = ?", options.sender, initial.item);
      return {
        id: input.id,
        itemId: initial.item,
        uploads: uploadsInOrder(
          plan,
          ids.map((r) => r.id),
        ),
      };
    }

    if (input.files.some((file) => file.size === 0)) {
      // Empty files bypass the receiver, so recreate their proven bytes here on every new upload.
      // A blob row alone cannot certify that an existing payload is still present and intact.
      emptyPrepared = true;
      ctx.blobs.adoptEmpty();
    }

    const result = ctx.db.tx(() => {
      assertTransferAvailability(ctx, target);
      const plan = planNodes(input);
      if (
        options.principal.kind === "grant" &&
        ctx.db.value<number>("SELECT count(*) FROM transfers WHERE principal = ? AND state = 'open'", principal)! >= 3
      )
        fail(429, "Finish or cancel an open transfer before sending more files.");
      if (!ctx.transfers.renewTab(input.tab, options.principal)) fail(409, TAB_CLOSED);
      const text = input.text?.trim() ? input.text : null;
      if (!plan.length && text === null) fail(400, "Choose something to send.");
      const bytes = input.files.reduce((sum, f) => sum + f.size, 0) + (text === null ? 0 : Buffer.byteLength(text));
      admit(ctx, options, bytes, plan.length + (text === null ? 0 : 1));

      const now = Date.now();
      const itemName = options.itemName ?? input.name?.normalize("NFC") ?? null;
      const safeItemName = itemName === null ? null : cleanName(itemName);
      let itemId = options.itemId;
      if (itemId) ctx.library.owned(options.owner, itemId, { live: true });
      else {
        itemId = uuidv7();
        // Null is a choice too: kept until deleted. Left out, the owner's own setting applies.
        const chosen =
          input.retentionDays !== undefined
            ? input.retentionDays
            : ctx.db.value<number | null>("SELECT retention_days FROM users WHERE id = ?", options.owner)!;
        const days = allowedKeepDays(ctx, options.owner, chosen);
        ctx.db.run(
          "INSERT INTO items(id, owner, name, created, retention_days, max_age_days, request_id, sender) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
          itemId,
          options.owner,
          safeItemName,
          now,
          days,
          ctx.db.value<number | null>("SELECT max_retention_days FROM users WHERE id = ?", options.owner)!,
          options.requestId ?? null,
          options.sender ?? null,
        );
      }
      ctx.db.run(
        "INSERT INTO transfers(id, principal, owner, item, tab, state, request_hash, created) VALUES(?, ?, ?, ?, ?, 'open', ?, ?)",
        input.id,
        principal,
        options.owner,
        itemId,
        input.tab,
        requestHash,
        now,
      );

      const appending = options.itemId !== undefined;
      let position = ctx.db.value<number>("SELECT coalesce(max(position) + 1, 0) FROM nodes WHERE item = ?", itemId)!;
      const insertNode = ctx.db.sqlite.prepare(
        `INSERT INTO nodes(id, item, owner, parent, name, kind, state, size, mime, blob, text, created, position)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertUpload = ctx.db.sqlite.prepare(
        "INSERT INTO uploads(id, transfer, node, size, created, touched, completed) VALUES(?, ?, ?, ?, ?, ?, ?)",
      );
      const findSibling = ctx.db.sqlite.prepare(
        "SELECT id, kind FROM nodes WHERE item = ? AND ifnull(parent, '') = ? AND name = ? COLLATE NOCASE",
      );
      const ids = new Map<string, string>();
      const uploads: string[] = [];
      const topTaken = new Set<string>();
      if (appending)
        for (const row of ctx.db.all<{ name: string }>(
          "SELECT name FROM nodes WHERE item = ? AND parent IS NULL",
          itemId,
        ))
          topTaken.add(foldCase(row.name));
      try {
        for (const node of plan) {
          const parent = node.parentKey === null ? null : ids.get(node.parentKey)!;
          // Appending submissions are independent top-level entries. A collision gets a suffix,
          // while the upload response below continues to expose the client's original path.
          const name =
            appending && node.parentKey === null ? uniqueName(node.name, topTaken, node.kind === "file") : node.name;
          if (node.parentKey === null) topTaken.add(foldCase(name));
          if (node.kind === "folder") {
            const sibling =
              appending && node.parentKey !== null
                ? (findSibling.get(itemId, parent ?? "", node.name) as { id: string; kind: string } | undefined)
                : undefined;
            if (sibling && sibling.kind !== "folder") fail(409, NAME_TAKEN);
            if (sibling) {
              ids.set(node.key, sibling.id);
              continue;
            }
            const id = uuidv7();
            insertNode.run(
              id,
              itemId,
              options.owner,
              parent,
              name,
              "folder",
              "ready",
              0,
              "",
              null,
              null,
              now,
              position++,
            );
            ids.set(node.key, id);
            continue;
          }
          const file = input.files[node.file!];
          const id = uuidv7();
          const blob = file.size === 0 ? EMPTY_SHA256 : null;
          const mime = file.mime.slice(0, 120);
          insertNode.run(
            id,
            itemId,
            options.owner,
            parent,
            name,
            "file",
            blob ? "ready" : "pending",
            file.size,
            mime,
            blob,
            null,
            now,
            position++,
          );
          const upload = uuidv7();
          insertUpload.run(upload, input.id, id, file.size, now, now, blob ? now : null);
          uploads[node.file!] = upload;
          ids.set(node.key, id);
        }
        if (text !== null) {
          insertNode.run(
            uuidv7(),
            itemId,
            options.owner,
            null,
            textName(topTaken),
            "text",
            "ready",
            Buffer.byteLength(text),
            "text/plain",
            null,
            text,
            now,
            position++,
          );
        }
      } catch (error) {
        if (isUniqueViolation(error)) fail(409, NAME_TAKEN);
        throw error;
      }
      assertTransferAvailability(ctx, { ...target, item: itemId });
      if (text !== null || input.files.some((f) => f.size === 0) || (!input.files.length && plan.length))
        startRetention(ctx, itemId);
      // Uploaded files count as they finish; empty files are complete already. A note is data, not a file.
      ctx.usage.add(options.owner, {
        files: input.files.filter((f) => f.size === 0).length,
        [options.principal.kind === "member" ? "uploaded" : "received"]: text === null ? 0 : Buffer.byteLength(text),
      });
      publishItemChange(ctx, options.owner, itemId);
      return { id: input.id, itemId, uploads: uploadsInOrder(plan, uploads) };
    });
    return result;
  } catch (error) {
    ensureTransferAvailability(ctx, target);
    throw error;
  } finally {
    if (emptyPrepared) {
      // This runs after our publication transaction resolves, including a failed adoption. Its
      // durable blob row or cleanup intent survives any remaining unlink or directory-sync failure.
      try {
        ctx.blobs.collect([EMPTY_SHA256]);
      } catch (error) {
        ctx.log.error({ err: error }, "empty blob cleanup failed");
      }
    }
  }
}
