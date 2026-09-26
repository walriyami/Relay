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
import { EXCERPT_CHARS, summarize, type StoredSummary, type SummaryNode } from "./summary.ts";

const ITEM_COLUMNS = "id, owner, name, created, expires, trashed, request_id";

export const isLive = (item: Pick<ItemRow, "trashed" | "expires">, now = Date.now()) =>
  item.trashed === null && (item.expires === null || item.expires > now);

export function owned(ctx: Context, owner: string, itemId: string, options: { live?: boolean } = {}): ItemRow {
  const item =
    ctx.db.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ? AND owner = ?`, itemId, owner) ??
    notFound("That item");
  if (options.live && !isLive(item)) fail(410, "This item is in Trash or has expired.");
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
    if (!row || result.has(id)) continue;
    const { name, ...stored } = JSON.parse(row.summary) as StoredSummary;
    result.set(id, {
      id,
      name: row.name ?? name ?? (uploading.has(id) ? "Uploading…" : "Empty"),
      autoName: row.name === null,
      created: row.created,
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
      `WITH RECURSIVE tree(id, path) AS (
         SELECT id, name FROM nodes WHERE item = ? AND parent IS NULL AND state = 'ready'
         UNION ALL
         SELECT n.id, tree.path || '/' || n.name FROM nodes n JOIN tree ON n.parent = tree.id WHERE n.state = 'ready'
       )
       SELECT n.id, n.name, tree.path, n.kind, n.size, n.mime, n.parent, n.created, n.text
       FROM tree JOIN nodes n ON n.id = tree.id ORDER BY tree.path`,
      itemId,
    )
    .map(({ text, ...node }) => (node.kind === "text" ? { ...node, text: text ?? "" } : node));
}

export function listItems(ctx: Context, owner: string, query: Query<typeof api.items.list>): ItemPage {
  const now = Date.now();
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
      AND (? = '' OR instr(${displayName}, lower(?)) > 0
        OR EXISTS (SELECT 1 FROM nodes n WHERE n.item = i.id AND (${inName} OR ${inText})))`;
  const args = [owner, ...(query.view === "trash" ? [] : [now]), q, q, q, q];
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
    items: rows.map(({ id, name, text }) => {
      const match: SearchMatch | null =
        name !== null
          ? { in: "name", text: name }
          : text !== null
            ? { in: "text", text: excerpt(...(JSON.parse(text) as [number, number, string])) }
            : null;
      return { ...found.get(id)!, ...(match ? { match } : {}) };
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
  owned(ctx, owner, itemId);
  return {
    ...summaries(ctx, [itemId]).get(itemId)!,
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
    const item = owned(ctx, owner, itemId);
    if (name !== undefined) {
      // Trash is read-only: restore an item before renaming it.
      if (item.trashed !== null) fail(409, "Restore this item before renaming it.");
      ctx.db.run("UPDATE items SET name = ? WHERE id = ?", name, itemId);
    }
    if (body.retentionDays !== undefined)
      ctx.db.run(
        "UPDATE items SET expires = ? WHERE id = ?",
        body.retentionDays === null ? null : Date.now() + body.retentionDays * DAY_MS,
        itemId,
      );
  });
  ctx.events.publish(owner, "items", "links", "deliveries");
  return summaries(ctx, [itemId]).get(itemId)!;
}

/** Moves an item to Trash: its links stop working and its unfinished transfers are cancelled. */
export function trashItem(ctx: Context, owner: string, itemId: string) {
  const item = owned(ctx, owner, itemId);
  if (item.trashed !== null) return;
  const now = Date.now();
  ctx.db.tx(() => trashItemInTransaction(ctx, itemId, now));
  ctx.events.publish(owner, "items", "links", "deliveries");
}

function trashItemInTransaction(ctx: Context, itemId: string, now: number) {
  ctx.db.run("UPDATE items SET trashed = ? WHERE id = ?", now, itemId);
  ctx.db.run("UPDATE links SET revoked = ? WHERE item = ? AND revoked IS NULL", now, itemId);
  ctx.transfers.cancelForItem(itemId);
}

/** Applies a bounded visible-page operation after validating every selected row inside one transaction. */
export function bulkItems(ctx: Context, owner: string, body: Body<typeof api.items.bulk>) {
  const now = Date.now();
  const result = ctx.db.tx(() => {
    const ids = JSON.stringify(body.ids);
    const rows = ctx.db.all<Pick<ItemRow, "id" | "trashed" | "expires">>(
      "SELECT id, trashed, expires FROM items WHERE owner = ? AND id IN (SELECT value FROM json_each(?))",
      owner,
      ids,
    );
    if (rows.length !== body.ids.length) notFound("That item");
    if (
      rows.some((item) =>
        body.operation === "restore"
          ? item.trashed === null
          : item.trashed !== null || (item.expires !== null && item.expires <= now),
      )
    )
      fail(409, "Some selected items are no longer in that view. Refresh and try again.");

    if (body.operation === "retention") {
      const expires = body.retentionDays === null ? null : now + body.retentionDays * DAY_MS;
      ctx.db.run(
        "UPDATE items SET expires = ? WHERE owner = ? AND id IN (SELECT value FROM json_each(?))",
        expires,
        owner,
        ids,
      );
    } else if (body.operation === "restore") {
      ctx.db.run(
        "UPDATE items SET trashed = NULL, expires = NULL WHERE owner = ? AND id IN (SELECT value FROM json_each(?))",
        owner,
        ids,
      );
    } else {
      for (const item of rows) trashItemInTransaction(ctx, item.id, now);
    }
    return rows.length;
  });
  ctx.events.publish(owner, "items", "links", "deliveries");
  return { updated: result };
}

/** Restoring keeps the item indefinitely; links revoked by trashing stay revoked. */
export function restoreItem(ctx: Context, owner: string, itemId: string) {
  const item = owned(ctx, owner, itemId);
  if (item.trashed === null) fail(409, "That item is not in Trash.");
  ctx.db.run("UPDATE items SET trashed = NULL, expires = NULL WHERE id = ?", itemId);
  ctx.events.publish(owner, "items", "links", "deliveries");
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
  ctx.blobs.collect(blobs);
  ctx.events.publish(owner, "items", "links", "deliveries");
}

/** Expired items move to Trash; each member's Trash is emptied after their own `trash_days`. */
export function sweep(ctx: Context, now: number) {
  for (const item of ctx.db.all<{ id: string; owner: string }>(
    "SELECT id, owner FROM items WHERE trashed IS NULL AND expires IS NOT NULL AND expires <= ?",
    now,
  ))
    trashItem(ctx, item.owner, item.id);
  for (const item of ctx.db.all<{ id: string }>(
    "SELECT i.id FROM items i JOIN users u ON u.id = i.owner WHERE i.trashed IS NOT NULL AND i.trashed <= ? - u.trash_days * ?",
    now,
    DAY_MS,
  ))
    purge(ctx, item.id);
}
