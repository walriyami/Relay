/** Offline control adapter. Invoke only with the service stopped and a verified backup. */
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "./db/database.ts";
const root = resolve(process.env.RELAY_DATA || ".data");
const mode = process.argv[2];
if (!["--content", "--clone"].includes(mode)) throw new Error("Choose --content or --clone. A backup is required.");
const db = new Database(join(root, "relay.sqlite"));
try {
  db.tx(() => {
    if (mode === "--clone") {
      db.run("DELETE FROM login_codes");
      db.run("DELETE FROM sessions");
      db.run("DELETE FROM devices");
      db.run("DELETE FROM passkeys");
      db.run("DELETE FROM sso_flows");
      db.run("DELETE FROM external_identities");
    } else {
      const keep = new Set([
        "users",
        "settings",
        "devices",
        "sessions",
        "passkeys",
        "invites",
        "login_codes",
        "external_identities",
        "external_sessions",
        "sso_flows",
      ]);
      const tables = db
        .all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .map((t) => t.name)
        .filter((t) => !keep.has(t));
      db.sqlite.exec("PRAGMA defer_foreign_keys=ON");
      for (const table of tables) {
        if (!/^[a-z_]+$/.test(table)) throw new Error("Unexpected database table.");
        db.run(`DELETE FROM ${table}`);
      }
      db.run("UPDATE users SET bytes_used=0, activity_seen=0");
      if (db.all("PRAGMA foreign_key_check").length) throw new Error("Reset would leave broken references.");
    }
  });
} finally {
  db.close();
}
if (mode === "--content")
  for (const dir of ["blobs", "uploads", "thumbnails"]) {
    rmSync(join(root, dir), { recursive: true, force: true });
    mkdirSync(join(root, dir), { mode: 0o700 });
  }
if (mode === "--clone") for (const file of ["secret.key", "setup.key"]) rmSync(join(root, file), { force: true });
process.stdout.write(
  mode === "--content"
    ? "Transfers and content cleared; accounts and settings preserved.\n"
    : "Clone sessions and hostname-bound credentials cleared.\n",
);
