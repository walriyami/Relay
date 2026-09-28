import type { Context } from "../../context.ts";
import { DEFAULTS, withinLimit, type MemberLimits } from "../../../shared/model.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import { fail } from "../../lib/errors.ts";
import { LIMIT_COLUMNS, limitValues } from "./member-limits.ts";

export const USERNAME_TAKEN = "That username is taken.";

/**
 * A new account with the limits it was invited with. Its own settings start at the built-in values,
 * brought within those limits. Runs inside the caller's transaction.
 */
export function insertUser(
  ctx: Context,
  account: { username: string; passwordHash: string; admin: boolean },
  limits: MemberLimits,
  now: number,
) {
  if (ctx.db.get("SELECT 1 FROM users WHERE username = ?", account.username)) fail(409, USERNAME_TAKEN);
  const id = uuidv7(now);
  ctx.db.run(
    `INSERT INTO users(id, username, password_hash, admin, ${LIMIT_COLUMNS}, retention_days, trash_days, prefs, created)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    account.username,
    account.passwordHash,
    account.admin ? 1 : 0,
    ...limitValues(limits),
    withinLimit(null, limits.keepDays),
    DEFAULTS.trashDays,
    JSON.stringify({ linkDays: withinLimit(DEFAULTS.linkDays, limits.linkDays) }),
    now,
  );
  return id;
}

/** Changes an account's username, refusing one another account has. Runs inside the caller's transaction. */
export function renameUser(ctx: Context, userId: string, username: string) {
  if (ctx.db.get("SELECT 1 FROM users WHERE username = ? AND id != ?", username, userId)) fail(409, USERNAME_TAKEN);
  ctx.db.run("UPDATE users SET username = ? WHERE id = ?", username, userId);
}
