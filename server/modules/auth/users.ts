import type { Context } from "../../context.ts";
import type { MemberDefaults } from "../../../shared/model.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { fail } from "../../lib/errors.ts";
import { readPrefs } from "./sessions.ts";

export const USERNAME_TAKEN = "That username is taken.";

/** A new account starting with `values` (what members get now). Runs inside the caller's transaction. */
export function insertUser(
  ctx: Context,
  account: { username: string; passwordHash: string; admin: boolean },
  values: MemberDefaults,
  now: number,
) {
  if (ctx.db.get("SELECT 1 FROM users WHERE username = ?", account.username)) fail(409, USERNAME_TAKEN);
  const id = uuidv7(now);
  ctx.db.run(
    `INSERT INTO users(id, username, password_hash, admin, quota, retention_days, trash_days, prefs, created)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    account.username,
    account.passwordHash,
    account.admin ? 1 : 0,
    values.quota,
    values.retentionDays,
    values.trashDays,
    JSON.stringify({ linkDays: values.linkDays }),
    now,
  );
  return id;
}

/** Sets the given member values of one account; the others stay as they are. */
export function setMemberValues(ctx: Context, userId: string, values: Partial<MemberDefaults>) {
  ctx.db.tx(() => {
    if (values.quota !== undefined) ctx.db.run("UPDATE users SET quota = ? WHERE id = ?", values.quota, userId);
    if (values.retentionDays !== undefined)
      ctx.db.run("UPDATE users SET retention_days = ? WHERE id = ?", values.retentionDays, userId);
    if (values.trashDays !== undefined)
      ctx.db.run("UPDATE users SET trash_days = ? WHERE id = ?", values.trashDays, userId);
    if (values.linkDays !== undefined) {
      const prefs = readPrefs(ctx.db.value<string>("SELECT prefs FROM users WHERE id = ?", userId)!);
      ctx.db.run(
        "UPDATE users SET prefs = ? WHERE id = ?",
        JSON.stringify({ ...prefs, linkDays: values.linkDays }),
        userId,
      );
    }
  });
}

/** Changes an account's username, refusing one another account has. Runs inside the caller's transaction. */
export function renameUser(ctx: Context, userId: string, username: string) {
  if (ctx.db.get("SELECT 1 FROM users WHERE username = ? AND id != ?", username, userId)) fail(409, USERNAME_TAKEN);
  ctx.db.run("UPDATE users SET username = ? WHERE id = ?", username, userId);
}
