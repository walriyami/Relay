import {
  type ItemDetail,
  type ItemPage,
  type ItemSummary,
  type Node,
  type SearchMatch,
} from "../../../shared/model.ts";
import type { api, Body, Query } from "../../../shared/api.ts";
import type { Context, ItemRow } from "../../context.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { cleanName } from "../../lib/names.ts";
import { DAY_MS } from "../../lib/time.ts";
import { earlier, hardDeadline, setRetention } from "./retention.ts";
import { EXCERPT_CHARS, summarize, type StoredSummary, type SummaryNode } from "./summary.ts";

const ITEM_COLUMNS =
  "id, owner, name, created, expires, first_saved_at, retention_days, max_age_days, trashed, purge_at, request_id";

export const isLive = (item: Pick<ItemRow, "trashed" | "expires">, now = Date.now()) =>
  item.trashed === null && (item.expires === null || item.expires > now);

export function owned(ctx: Context, owner: string, itemId: string, options: { live?: boolean } = {}): ItemRow {
  const item =
    ctx.db.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ? AND owner = ?`, itemId, owner) ??
    notFound("That item");
  if (options.live && !isLive(item)) fail(410, "This item is in Trash or has expired.");
  return item;
}

/** Owner previews include recoverable Trash, but never content past its final deadline. */
function readable(ctx: Context, item: ItemRow, now: number) {
  let end = earlier(item.purge_at, hardDeadline(item));
  if (item.trashed === null && item.expires !== null && item.expires <= now) {
    const days = ctx.db.value<number>("SELECT trash_days FROM users WHERE id = ?", item.owner)!;
    end = earlier(end, item.expires + days * DAY_MS);
  }
  return end === null || end > now;
}

export function ownedReadable(ctx: Context, owner: string, itemId: string): ItemRow {
  const item = owned(ctx, owner, itemId);
  if (!readable(ctx, item, Date.now())) fail(410, "This item's recovery period has ended.");
  return item;
}

/** Recomputes the cached summaries of the given items that are marked dirty. */
function refresh(ctx: Context, ids: string[]) {
  const list = JSON.stringify(ids);
  const dirty = ctx.db
    .all<{ id: string }>(
      "SELECT id FROM items WHERE summary_dirty = 1 AND id IN (SELECT value FROM json_each(?))",
      list,
    )
    .map((r) => r.id);
  if (!dirty.length) return;
  const grouped = new Map<string, SummaryNode[]>(dirty.map((id) => [id, []]));
  const nodes = ctx.db.all<SummaryNode & { item: string }>(
    `SELECT item, id, parent, name, kind, size, mime, position, substr(text, 1, ${EXCERPT_CHARS}) AS excerpt,
       length(text) AS chars
     FROM nodes WHERE state = 'ready' AND item IN (SELECT value FROM json_each(?))`,
    JSON.stringify(dirty),
  );
  for (const node of nodes) grouped.get(node.item)!.push(node);
  ctx.db.tx(() => {
    for (const [id, itemNodes] of grouped)
      ctx.db.run(
        "UPDATE items SET summary = ?, summary_dirty = 0 WHERE id = ?",
        JSON.stringify(summarize(itemNodes)),
        id,
      );
  });
}

type SummaryRow = ItemRow & { summary: string };

export function summaries(ctx: Context, ids: string[]): Map<string, ItemSummary> {
  const result = new Map<string, ItemSummary>();
  if (!ids.length) return result;
  refresh(ctx, ids);
  const now = Date.now();
  const list = JSON.stringify(ids);
  const rows = new Map(
    ctx.db
      .all<SummaryRow>(`SELECT ${ITEM_COLUMNS}, summary FROM items WHERE id IN (SELECT value FROM json_each(?))`, list)
      .map((r) => [r.id, r]),
  );
  const items = (sql: string, ...args: (string | number)[]) =>
    new Set(ctx.db.all<{ item: string }>(sql, ...args).map((r) => r.item));
  const linked = items(
    "SELECT DISTINCT item FROM links WHERE revoked IS NULL AND (expires IS NULL OR expires > ?) AND item IN (SELECT value FROM json_each(?))",
    now,
    list,
  );
  const uploading = items(
    "SELECT DISTINCT item FROM nodes WHERE state = 'pending' AND item IN (SELECT value FROM json_each(?))",
    list,
  );
  for (const id of ids) {
    const row = rows.get(id);
    if (!row || result.has(id) || !readable(ctx, row, now)) continue;
    const { name, ...stored } = JSON.parse(row.summary) as StoredSummary;
    result.set(id, {
      id,
      name: row.name ?? name ?? (uploading.has(id) ? "Uploading…" : "Empty"),
      autoName: row.name === null,
      created: row.created,
      firstSavedAt: row.first_saved_at,
      hardExpires: hardDeadline(row),
      maxAgeDays: row.max_age_days,
      purgeAt: row.purge_at,
      expires: row.expires,
      trashed: row.trashed,
      requestId: row.request_id,
      ...stored,
      linked: linked.has(id) && isLive(row, now),
      uploading: uploading.has(id),
    });
  }
  return result;
}

type NodeRow = Omit<Node, "text"> & { text: string | null };

/** Every ready node of an item with its path, parents before children. */
export function nodes(ctx: Context, itemId: string): Node[] {
  return ctx.db
    .all<NodeRow>(
      // The walk carries every column: joining back to nodes lets the planner scan the whole table.
      `WITH RECURSIVE tree(id, name, path, kind, size, mime, parent, created, text) AS (
         SELECT id, name, name, kind, size, mime, parent, created, text
         FROM nodes WHERE item = ? AND parent IS NULL AND state = 'ready'
         UNION ALL
         SELECT n.id, n.name, tree.path || '/' || n.name, n.kind, n.size, n.mime, n.parent, n.created, n.text
         FROM nodes n JOIN tree ON n.parent = tree.id WHERE n.state = 'ready'
       )
       SELECT id, name, path, kind, size, mime, parent, created, text FROM tree ORDER BY path`,
      itemId,
    )
    .map(({ text, ...node }) => (node.kind === "text" ? { ...node, text: text ?? "" } : node));
}

export function listItems(ctx: Context, owner: string, query: Query<typeof api.items.list>): ItemPage {
  const now = Date.now();
  expireItems(ctx, owner, now);
  refresh(
    ctx,
    ctx.db.all<{ id: string }>("SELECT id FROM items WHERE owner = ? AND summary_dirty = 1", owner).map((r) => r.id),
  );
  const view =
    query.view === "trash" ? "i.trashed IS NOT NULL" : "i.trashed IS NULL AND (i.expires IS NULL OR i.expires > ?)";
  const displayName = "lower(coalesce(i.name, i.summary ->> '$.name', ''))";
  const order = {
    new: "i.created DESC, i.id DESC",
    old: "i.created ASC, i.id ASC",
    name: `${displayName} ASC, i.created DESC, i.id DESC`,
    size: "i.summary ->> '$.bytes' DESC, i.created DESC, i.id DESC",
  }[query.sort];
  const q = query.q.trim();
  const inName = "n.state = 'ready' AND instr(lower(n.name), lower(?)) > 0";
  const inText = "n.state = 'ready' AND n.kind = 'text' AND instr(lower(n.text), lower(?)) > 0";
  const matching = `FROM items i
    WHERE i.owner = ? AND ${view}
      AND (i.purge_at IS NULL OR i.purge_at > ?)
      AND (i.first_saved_at IS NULL OR i.max_age_days IS NULL OR i.first_saved_at + i.max_age_days * ${DAY_MS} > ?)
      AND (? = '' OR instr(${displayName}, lower(?)) > 0
        OR EXISTS (SELECT 1 FROM nodes n WHERE n.item = i.id AND (${inName} OR ${inText})))`;
  const args = [owner, ...(query.view === "trash" ? [] : [now]), now, now, q, q, q, q];
  // An item whose own name matches needs no explanation; otherwise say what inside it matched.
  const rows = ctx.db.all<{ id: string; name: string | null; text: string | null }>(
    `SELECT i.id,
       CASE WHEN ? = '' OR instr(${displayName}, lower(?)) > 0 THEN NULL ELSE
         (SELECT n.name FROM nodes n WHERE n.item = i.id AND ${inName} ORDER BY n.position LIMIT 1) END AS name,
       CASE WHEN ? = '' OR instr(${displayName}, lower(?)) > 0 THEN NULL ELSE
         (SELECT json_array(max(1, instr(lower(n.text), lower(?)) - ${EXCERPT_BEFORE}), length(n.text),
            substr(n.text, max(1, instr(lower(n.text), lower(?)) - ${EXCERPT_BEFORE}), ${EXCERPT_LENGTH} + length(?)))
          FROM nodes n WHERE n.item = i.id AND ${inText} ORDER BY n.position LIMIT 1) END AS text
     ${matching} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...[q, q, q, q, q, q, q, q, q],
    ...args,
    query.limit,
    query.offset,
  );
  const total = ctx.db.value<number>(`SELECT count(*) ${matching}`, ...args)!;
  const found = summaries(
    ctx,
    rows.map((r) => r.id),
  );
  return {
    items: rows.flatMap(({ id, name, text }) => {
      const summary = found.get(id);
      if (!summary) return [];
      const match: SearchMatch | null =
        name !== null
          ? { in: "name", text: name }
          : text !== null
            ? { in: "text", text: excerpt(...(JSON.parse(text) as [number, number, string])) }
            : null;
      return [{ ...summary, ...(match ? { match } : {}) }];
    }),
    total,
  };
}

/** Characters of text shown before a match, and around it in all. */
const EXCERPT_BEFORE = 24;
const EXCERPT_LENGTH = 64;
/**
 * "…the fridge is empty…": one line of text around the first match. `from` is where the slice
 * starts in the whole text (from 1) and `length` the whole text's length; a word cut at either
 * end is dropped.
 */
function excerpt(from: number, length: number, slice: string) {
  let body = slice.replace(/\s+/g, " ");
  const cutStart = from > 1;
  const cutEnd = from - 1 + slice.length < length;
  if (cutStart && body.includes(" ")) body = body.slice(body.indexOf(" ") + 1);
  if (cutEnd && body.includes(" ")) body = body.slice(0, body.lastIndexOf(" "));
  return `${cutStart ? "…" : ""}${body.trim()}${cutEnd ? "…" : ""}`;
}

export function itemDetail(ctx: Context, owner: string, itemId: string): ItemDetail {
  ownedReadable(ctx, owner, itemId);
  return {
    ...(summaries(ctx, [itemId]).get(itemId) ?? fail(410, "This item's recovery period has ended.")),
    nodes: nodes(ctx, itemId),
    links: ctx.links.forItem(owner, itemId),
  };
}

/** Renames an item (null goes back to the automatic name) or changes how long it is kept. */
export function updateItem(
  ctx: Context,
  owner: string,
  itemId: string,
  body: Body<typeof api.items.update>,
): ItemSummary {
  if (body.name === undefined && body.retentionDays === undefined) fail(400, "Nothing to change.");
  const name = body.name == null ? body.name : cleanName(body.name);
  ctx.db.tx(() => {
    const item = owned(ctx, owner, itemId, { live: true });
    if (name !== undefined) ctx.db.run("UPDATE items SET name = ? WHERE id = ?", name, itemId);
    if (body.retentionDays !== undefined) setRetention(ctx, item, body.retentionDays);
  });
  ctx.events.publish(owner, "items", "links", "deliveries", "requests");
  return summaries(ctx, [itemId]).get(itemId)!;
}

/** Moves an item to Trash: its links stop working and its unfinished transfers are cancelled. */
export function trashItem(ctx: Context, owner: string, itemId: string) {
  const item = owned(ctx, owner, itemId);
  if (item.trashed !== null) return;
  const now = Date.now();
  ctx.db.tx(() => trashItemInTransaction(ctx, item, item.expires === null ? now : Math.min(now, item.expires)));
  ctx.events.publish(owner, "items", "links", "deliveries", "requests");
}

function trashItemInTransaction(ctx: Context, item: ItemRow, at: number) {
  const days = ctx.db.value<number>("SELECT trash_days FROM users WHERE id = ?", item.owner)!;
  const purgeAt = earlier(at + days * DAY_MS, hardDeadline(item));
  ctx.db.run("UPDATE items SET trashed = ?, purge_at = ? WHERE id = ?", at, purgeAt, item.id);
  ctx.db.run("UPDATE links SET revoked = ? WHERE item = ? AND revoked IS NULL", at, item.id);
  ctx.transfers.cancelForItem(item.id);
}

/** Freeze automatic Trash deadlines under the current setting before that setting can change. */
export function expireItems(ctx: Context, owner: string, now = Date.now()) {
  ctx.db.tx(() => {
    for (const item of ctx.db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE owner = ? AND trashed IS NULL AND expires IS NOT NULL AND expires <= ?`,
      owner,
      now,
    ))
      trashItemInTransaction(ctx, item, item.expires!);
  });
}

function recoverable(item: ItemRow, now: number) {
  const end = earlier(item.purge_at, hardDeadline(item));
  return item.trashed !== null && end !== null && end > now;
}

function restoreInTransaction(ctx: Context, item: ItemRow, now: number) {
  if (!recoverable(item, now)) fail(410, "This item's recovery period has ended.");
  setRetention(ctx, item, null, now);
  ctx.db.run("UPDATE items SET trashed = NULL, purge_at = NULL WHERE id = ?", item.id);
}

/** Applies a bounded visible-page operation after validating every selected row inside one transaction. */
export function bulkItems(ctx: Context, owner: string, body: Body<typeof api.items.bulk>) {
  const now = Date.now();
  const result = ctx.db.tx(() => {
    const ids = JSON.stringify(body.ids);
    const rows = ctx.db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE owner = ? AND id IN (SELECT value FROM json_each(?))`,
      owner,
      ids,
    );
    if (rows.length !== body.ids.length) notFound("That item");
    if (
      rows.some((item) =>
        body.operation === "restore"
          ? !recoverable(item, now)
          : item.trashed !== null || (item.expires !== null && item.expires <= now),
      )
    )
      fail(409, "Some selected items are no longer in that view. Refresh and try again.");

    for (const item of rows) {
      if (body.operation === "retention") setRetention(ctx, item, body.retentionDays, now);
      else if (body.operation === "restore") restoreInTransaction(ctx, item, now);
      else trashItemInTransaction(ctx, item, now);
    }
    return rows.length;
  });
  ctx.events.publish(owner, "items", "links", "deliveries", "requests");
  return { updated: result };
}

/**
 * Restoring keeps the item until deleted, or as long as the member may keep uploads; links revoked
 * by trashing stay revoked.
 */
export function restoreItem(ctx: Context, owner: string, itemId: string) {
  ctx.db.tx(() => {
    const item = owned(ctx, owner, itemId);
    if (item.trashed === null) fail(409, "That item is not in Trash.");
    restoreInTransaction(ctx, item, Date.now());
  });
  ctx.events.publish(owner, "items", "links", "deliveries", "requests");
}

export function removeItem(ctx: Context, owner: string, itemId: string) {
  if (owned(ctx, owner, itemId).trashed === null) fail(409, "Move this to Trash before deleting it forever.");
  purge(ctx, itemId);
}

export function emptyTrash(ctx: Context, owner: string) {
  const ids = ctx.db.all<{ id: string }>("SELECT id FROM items WHERE owner = ? AND trashed IS NOT NULL", owner);
  for (const { id } of ids) purge(ctx, id);
  return { removed: ids.length };
}

export function purge(ctx: Context, itemId: string) {
  const owner = ctx.db.value<string>("SELECT owner FROM items WHERE id = ?", itemId);
  if (owner === undefined) return;
  const blobs = ctx.db
    .all<{ blob: string }>("SELECT DISTINCT blob FROM nodes WHERE item = ? AND blob IS NOT NULL", itemId)
    .map((r) => r.blob);
  ctx.db.tx(() => {
    ctx.transfers.cancelForItem(itemId);
    ctx.db.run("DELETE FROM items WHERE id = ?", itemId);
  });
  try {
    ctx.blobs.collect(blobs);
  } catch (error) {
    // Unreferenced blob rows are durable cleanup work; maintenance retries after filesystem recovery.
    ctx.log.error({ err: error, item: itemId }, "Physical deletion pending; blob cleanup will retry");
  }
  ctx.events.publish(owner, "items", "links", "deliveries", "requests");
  ctx.events.broadcast("account");
}

/**
 * Deadlines remain anchored through outages; one broken item cannot stop independent cleanup. Each
 * item is its own transaction, and other work runs between them, so a backlog never stalls requests.
 */
export async function sweep(ctx: Context, now: number) {
  const next = () => new Promise((resolve) => setImmediate(resolve));
  const errors: unknown[] = [];
  const owners = new Set<string>();
  for (const item of ctx.db.all<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items WHERE trashed IS NULL AND expires IS NOT NULL AND expires <= ?`,
    now,
  )) {
    try {
      ctx.db.tx(() => trashItemInTransaction(ctx, item, item.expires!));
      owners.add(item.owner);
    } catch (error) {
      errors.push(error);
    }
    await next();
  }
  for (const item of ctx.db.all<{ id: string }>(
    "SELECT id FROM items WHERE trashed IS NOT NULL AND purge_at <= ?",
    now,
  )) {
    try {
      purge(ctx, item.id);
    } catch (error) {
      errors.push(error);
    }
    await next();
  }
  for (const owner of owners) ctx.events.publish(owner, "items", "links", "deliveries", "account", "requests");
  if (errors.length) throw new AggregateError(errors, "Some items could not be expired or purged");
}
