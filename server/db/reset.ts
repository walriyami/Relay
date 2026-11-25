// What the offline control adapter (server/control-reset.ts) clears. Both lists name tables
// explicitly: a table added to schema.sql later is kept by every reset until someone decides
// otherwise, and tests/control-reset.test.ts fails until it is listed here.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "./database.ts";
import { deleteNodeTree } from "./tree.ts";

/** Transfers and everything shared or counted from them. Accounts and settings survive. */
export const CONTENT_TABLES = [
  "requests",
  "items",
  "nodes",
  "stored_types",
  "blobs",
  "blob_cleanup",
  "tabs",
  "guest_grants",
  "transfers",
  "uploads",
  "links",
  "link_visits",
  "deliveries",
  "delivery_receipts",
  "activity",
  "usage",
  "traffic",
  "history",
  "nearby_invites",
  "nearby_guests",
] as const;

/**
 * Sign-ins tied to this copy's address and devices. A clone gets its own; accounts, passwords and
 * content stay. Deleting sessions also ends their shared sign-in links. Push subscriptions go too, with
 * the key they were made for, so a copy never notifies the original's phones.
 */
export const CLONE_TABLES = [
  "push_subscriptions",
  "login_codes",
  "sessions",
  "devices",
  "passkeys",
  "sso_flows",
  "external_identities",
] as const;

/**
 * Kept by a content reset. `pickup_codes` stays so a code that was ever printed is never handed to
 * someone else; deleting links and requests retires theirs.
 */
export const KEPT_TABLES = [
  "settings",
  "users",
  "devices",
  "sessions",
  "passkeys",
  "invites",
  "login_codes",
  "external_identities",
  "external_sessions",
  "sso_flows",
  "pickup_codes",
  "push_subscriptions",
] as const;

/** Clears content and its files. Run only with Relay stopped. */
export function resetContent(root: string) {
  const db = new Database(join(root, "relay.sqlite"));
  try {
    db.tx(() => {
      db.sqlite.exec("PRAGMA defer_foreign_keys = ON");
      // Deleting items would cascade down each folder tree, which SQLite refuses past ~1,000 levels.
      deleteNodeTree(db, null);
      for (const table of CONTENT_TABLES) db.run(`DELETE FROM ${table}`);
      db.run("UPDATE users SET bytes_used = 0, activity_seen = 0");
      if (db.all("PRAGMA foreign_key_check").length) throw new Error("Reset would leave broken references.");
    });
  } finally {
    db.close();
  }
  for (const dir of ["blobs", "uploads", "thumbnails"]) {
    rmSync(join(root, dir), { recursive: true, force: true });
    mkdirSync(join(root, dir), { mode: 0o700 });
  }
}

/** Clears this copy's sign-ins and the keys bound to its address. Run only with Relay stopped. */
export function resetClone(root: string) {
  const db = new Database(join(root, "relay.sqlite"));
  try {
    db.tx(() => {
      for (const table of CLONE_TABLES) db.run(`DELETE FROM ${table}`);
    });
  } finally {
    db.close();
  }
  for (const file of ["secret.key", "setup.key", "push-keys.json"]) rmSync(join(root, file), { force: true });
}
