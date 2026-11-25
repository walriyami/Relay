// POST /api/transfers: one synchronous transaction checks every limit, creates (or appends to) the
// item, its folders, the text node, a pending node and an upload row per file. Zero-byte files are
// completed on the spot. Retrying the same id with the same manifest returns the same result.
import { transferErrors } from "../../../shared/api.ts";
import { LIMITS, type TransferCreated } from "../../../shared/model.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { principalKey, type Context, type CreateTransferOptions, type TransferInput } from "../../context.ts";
import { isUniqueViolation } from "../../db/database.ts";
import { fail } from "../../lib/errors.ts";
import { cleanName } from "../../lib/names.ts";
import { sha256 } from "../../lib/secrets.ts";
import { EMPTY_SHA256 } from "../../storage/blobs.ts";
import { CAPACITY_FULL, DISK_FULL, RECIPIENT_FULL, bytesLabel, capacityRoom, diskRoom, quotaRoom } from "./room.ts";
import { allowedKeepDays } from "../auth/member-limits.ts";
import { foldCase, planNodes, type PlannedNode } from "./plan.ts";
import { publishItemChange } from "./publish.ts";
import { startRetention } from "../library/retention.ts";
import { assertTransferAvailability, ensureTransferAvailability } from "./availability.ts";

export const { tabClosed: TAB_CLOSED, moved: MOVED, cancelled: CANCELLED } = transferErrors;
const NAME_TAKEN = "A file or folder with that name already exists there.";

export { bytesLabel };

/** Open sends one request-link visitor may hold: per visit, and from one address across visits. */
const OPEN_PER_GRANT = 3;
const OPEN_PER_ADDRESS = 10;

/** NUL, and half of a surrogate pair on its own: characters a text can't be stored with. */
const UNSTORABLE = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The request's room, the owner's quota, service capacity and free disk space must all hold the new
 * bytes. Checked before the file list is planned, so a send that can't fit costs no planning;
 * the request's entry room is checked once the plan says how many entries it makes.
 */
function admit(ctx: Context, options: CreateTransferOptions, bytes: number) {
  if (options.limit) {
    const room = options.limit;
    if ((bytes > 0 && room.bytes === 0) || room.entries === 0) fail(413, "This request is full.");
    if (bytes > room.bytes) fail(413, `This request has room for ${bytesLabel(room.bytes)} more.`);
  }

  if (bytes > 0 && bytes > quotaRoom(ctx, options.owner))
    fail(
      413,
      options.principal.kind === "grant"
        ? RECIPIENT_FULL
        : "This would go over your storage limit. Free up space, or ask your administrator for more.",
    );
  // Room a visitor with a request link has declared but not yet sent doesn't count against a
  // member's upload, here or on the disk below (see room.ts). Visitors still count each other's.
  const visitor = options.principal.kind === "grant";
  if (bytes > 0 && bytes > capacityRoom(ctx, visitor)) fail(507, CAPACITY_FULL);
  if (bytes > 0 && bytes > diskRoom(ctx, visitor)) fail(507, DISK_FULL);
}

/**
 * Top-level names already used in an item, and for each name that collided, the number after the
 * last one handed out. Counting on from there keeps thousands of copies of one name quick; counting
 * from 2 every time took minutes and froze the server for everyone.
 */
type TakenNames = { names: Set<string>; next: Map<string, number> };

/** "Text.txt", or "Text (2).txt" and so on when that name is taken at the top level. */
function textName(taken: TakenNames) {
  for (let n = taken.next.get("\0text") ?? 1; ; n++) {
    const name = n === 1 ? "Text.txt" : `Text (${n}).txt`;
    if (!taken.names.has(foldCase(name))) {
      taken.next.set("\0text", n + 1);
      return name;
    }
  }
}

/** Add a suffix before the extension until a sibling name is available. */
function uniqueName(name: string, taken: TakenNames, preserveExtension = false) {
  if (!taken.names.has(foldCase(name))) return name;
  const dot = preserveExtension ? name.lastIndexOf(".") : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const key = foldCase(`${stem}\0${extension}`);
  for (let n = taken.next.get(key) ?? 2; ; n++) {
    const suffix = ` (${n})`;
    let boundedStem = stem;
    while (
      boundedStem &&
      (`${boundedStem}${suffix}${extension}`.length > LIMITS.nameLength ||
        Buffer.byteLength(`${boundedStem}${suffix}${extension}`) > 255)
    )
      boundedStem = [...boundedStem].slice(0, -1).join("");
    const candidate = `${boundedStem}${suffix}${extension}`;
    if (!taken.names.has(foldCase(candidate))) {
      taken.next.set(key, n + 1);
      return candidate;
    }
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
      if (initial.state === "cancelled") fail(410, CANCELLED);
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
      // The cheap checks come first: planning a long file list is the costly part.
      if (options.principal.kind === "grant") {
        if (
          ctx.db.value<number>("SELECT count(*) FROM transfers WHERE principal = ? AND state = 'open'", principal)! >=
          OPEN_PER_GRANT
        )
          fail(429, "Finish or cancel an open transfer before sending more files.");
        // A new visit (another /start) is a new grant, so its own count alone is easy to reset.
        if (
          ctx.db.value<number>(
            `SELECT count(*) FROM transfers t JOIN guest_grants g ON g.token_hash = substr(t.principal, 7)
             JOIN guest_grants mine ON mine.token_hash = ?
             WHERE t.state = 'open' AND t.principal LIKE 'grant:%'
               AND g.request_id = mine.request_id AND g.address = mine.address`,
            options.principal.tokenHash,
          )! >= OPEN_PER_ADDRESS
        )
          fail(429, "Too many sends to this request are still open from your network. Try again once they finish.");
      }
      if (!ctx.transfers.renewTab(input.tab, options.principal)) fail(409, TAB_CLOSED);
      const text = input.text?.trim() ? input.text : null;
      if (!input.files.length && !input.folders.length && text === null) fail(400, "Choose something to send.");
      // A visitor's text is limited in bytes, not characters, and must be text that can be stored.
      if (options.principal.kind === "grant" && text !== null) {
        if (Buffer.byteLength(text) > LIMITS.textBytes) fail(413, "This text is too long to send.");
        if (UNSTORABLE.test(text)) fail(400, "This text contains characters that can't be saved.");
      }
      const bytes = input.files.reduce((sum, f) => sum + f.size, 0) + (text === null ? 0 : Buffer.byteLength(text));
      admit(ctx, options, bytes);
      // A visitor's list already longer than the limit is refused before it is planned. (Planning
      // merges repeats and adds the folders that hold files, so the plan is checked as well.)
      const visitorEntries = (entries: number) => {
        if (options.principal.kind === "grant" && entries > LIMITS.visitorEntriesPerTransfer)
          fail(
            413,
            `Send up to ${LIMITS.visitorEntriesPerTransfer.toLocaleString("en-US")} files and folders at a time.`,
          );
      };
      visitorEntries(input.files.length + input.folders.length);
      const plan = planNodes(input);
      visitorEntries(plan.length);
      if (options.limit && plan.length + (text === null ? 0 : 1) > options.limit.entries)
        fail(413, "This request cannot take that many more files.");

      const now = Date.now();
      const named = typeof options.itemName === "function" ? options.itemName(plan) : options.itemName;
      const itemName = named ?? input.name?.normalize("NFC") ?? null;
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
      const topTaken: TakenNames = { names: new Set(), next: new Map() };
      if (appending)
        for (const row of ctx.db.all<{ name: string }>(
          "SELECT name FROM nodes WHERE item = ? AND parent IS NULL",
          itemId,
        ))
          topTaken.names.add(foldCase(row.name));
      try {
        for (const node of plan) {
          const parent = node.parentKey === null ? null : ids.get(node.parentKey)!;
          // Appending submissions are independent top-level entries. A collision gets a suffix,
          // while the upload response below continues to expose the client's original path.
          const name =
            appending && node.parentKey === null ? uniqueName(node.name, topTaken, node.kind === "file") : node.name;
          if (node.parentKey === null) topTaken.names.add(foldCase(name));
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
          // A type is a label for the browser; one with control characters is no type at all.
          // A type with control characters (a line break, say) is no type at all.
          // eslint-disable-next-line no-control-regex -- control characters are exactly what's refused.
          const mime = /[\0-\x1f\x7f]/.test(file.mime) ? "" : file.mime.slice(0, 120);
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
