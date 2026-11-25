import type { Database } from "./database.ts";

/**
 * Deletes nodes the deepest level first: one item's, or with `null` every item's.
 *
 * Deleting a folder cascades to its children through `nodes.parent`, and SQLite runs each level of
 * that cascade one trigger deeper, refusing past ~1,000 levels and rolling the whole delete back. Paths are now limited far below that, but trees
 * stored before the limit can be deeper. Removing children before their folder means no delete
 * ever cascades, so a tree of any depth goes, and the node triggers still run once per row,
 * keeping bytes_used, stored_types and item summaries right. Call inside a transaction.
 */
export function deleteNodeTree(db: Database, itemId: string | null) {
  // Separate anchors, so one item's delete finds its top level through the item index.
  const anchor = itemId === null ? "parent IS NULL" : "item = ? AND parent IS NULL";
  const levels = db.all<{ ids: string }>(
    `WITH RECURSIVE tree(id, depth) AS (
       SELECT id, 0 FROM nodes WHERE ${anchor}
       UNION ALL
       SELECT nodes.id, tree.depth + 1 FROM nodes JOIN tree ON nodes.parent = tree.id
     )
     SELECT json_group_array(id) AS ids FROM tree GROUP BY depth ORDER BY depth DESC`,
    ...(itemId === null ? [] : [itemId]),
  );
  for (const { ids } of levels) db.run("DELETE FROM nodes WHERE id IN (SELECT value FROM json_each(?))", ids);
}
