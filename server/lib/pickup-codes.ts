import type { Context } from "../context.ts";
import type { Database } from "../db/database.ts";
import { fail } from "./errors.ts";
import type { Secrets } from "./secrets.ts";
import { normalizeCode } from "./secrets.ts";
import { DEFAULT_CODE_LENGTH, type CodeLength } from "../../shared/codes.ts";
import { pickupCodeHeightened } from "./pickup-code-guard.ts";

export type PickupCodeKind = "share" | "request" | "invitation" | "device" | "nearby";
type RegisteredCode = { code_hash: string; nonce: number };
const SETTING = "pickupCodeLength";
const EFFECTIVE_SETTING = "pickupCodeEffectiveLength";
const RECOVERY_BLOCKED_SETTING = "pickupCodeRecoveryBlocked";
const RESOLUTION_UNAVAILABLE_SETTING = "pickupCodeResolutionUnavailable";

/** The code at `nonce` in the target's sequence, checked against the digest it was stored under. */
function codeAt(secrets: Secrets, kind: PickupCodeKind, targetId: string, row: RegisteredCode, length: CodeLength) {
  const code = secrets.pickupCodeFor(kind, targetId, row.nonce, length);
  if (secrets.pickupCodeHash(normalizeCode(code, length)!) !== row.code_hash)
    throw new Error(`Pickup code registry mismatch for ${kind} ${targetId}.`);
  return code;
}

export function preferredCodeLengthOf(db: Database): CodeLength {
  const value = db.setting(SETTING);
  if (value === undefined) return DEFAULT_CODE_LENGTH;
  if (value === "4" || value === "6") return Number(value) as CodeLength;
  throw new Error(`Invalid stored pickup code length: ${value}.`);
}

export function codeLengthOf(db: Database): CodeLength {
  const value = db.setting(EFFECTIVE_SETTING) ?? db.setting(SETTING);
  if (value === undefined) return DEFAULT_CODE_LENGTH;
  if (value === "4" || value === "6") return Number(value) as CodeLength;
  throw new Error(`Invalid stored effective pickup code length: ${value}.`);
}

/** Reserves a code in the permanent namespace, retrying collisions from every code length. */
export function issuePickupCode(
  db: Database,
  secrets: Secrets,
  kind: PickupCodeKind,
  targetId: string,
  length: CodeLength = codeLengthOf(db),
) {
  ensurePickupCodeResolutionAvailable(db);
  return db.tx(() => {
    const prior = db.get<RegisteredCode>(
      "SELECT code_hash, nonce FROM pickup_codes WHERE kind = ? AND target_id = ? AND retired IS NULL",
      kind,
      targetId,
    );
    if (prior) return { code: codeAt(secrets, kind, targetId, prior, length), codeHash: prior.code_hash };

    const namespaceSize = 10 ** length;
    // Reuse one compiled lookup for the bounded full-cycle scan. Preparing a new SQLite statement
    // for every candidate made a completely reserved namespace hold the single server process.
    const isReserved = db.sqlite.prepare("SELECT 1 FROM pickup_codes WHERE code_hash = ?");
    for (let nonce = 0; nonce < namespaceSize; nonce++) {
      const code = secrets.pickupCodeFor(kind, targetId, nonce, length);
      const codeHash = secrets.pickupCodeHash(normalizeCode(code, length)!);
      if (isReserved.get(codeHash)) continue;
      db.run(
        "INSERT INTO pickup_codes(code_hash, kind, target_id, nonce, created) VALUES(?, ?, ?, ?, ?)",
        codeHash,
        kind,
        targetId,
        nonce,
        Date.now(),
      );
      return { code, codeHash };
    }
    return fail(409, `No unused ${length}-digit codes remain. Choose a different code length.`);
  });
}

export function ensurePickupCodeResolutionAvailable(db: Database) {
  if (db.setting(RESOLUTION_UNAVAILABLE_SETTING) === "1")
    fail(503, "Numeric pickup codes are temporarily unavailable. Use the original link or try again later.");
}

/** Returns the current active code, or null when this target has no current assignment. */
export function getPickupCode(
  db: Database,
  secrets: Secrets,
  kind: PickupCodeKind,
  targetId: string,
  length: CodeLength = codeLengthOf(db),
): string | null {
  const row = db.get<RegisteredCode>(
    "SELECT code_hash, nonce FROM pickup_codes WHERE kind = ? AND target_id = ? AND retired IS NULL",
    kind,
    targetId,
  );
  return row ? codeAt(secrets, kind, targetId, row, length) : null;
}

/** Rotates every live assignment and its source hash in one transaction, preserving all URLs. */
export function rotatePickupCodes(ctx: Context, length: CodeLength, preferredLength: CodeLength = length) {
  if (codeLengthOf(ctx.db) === length && preferredCodeLengthOf(ctx.db) === preferredLength) return false;
  const now = Date.now();
  const owners = new Set<string>();

  ctx.db.tx(() => {
    const previous = ctx.db.all<{ code_hash: string; kind: PickupCodeKind; target_id: string }>(
      "SELECT code_hash, kind, target_id FROM pickup_codes WHERE retired IS NULL",
    );
    ctx.db.run("UPDATE pickup_codes SET retired = ? WHERE retired IS NULL", now);

    for (const row of previous) {
      switch (row.kind) {
        case "share": {
          const link = ctx.db.get<{
            owner: string;
            revoked: number | null;
            expires: number | null;
            trashed: number | null;
            item_expires: number | null;
          }>(
            `SELECT l.owner, l.revoked, l.expires, i.trashed, i.expires AS item_expires
             FROM links l JOIN items i ON i.id = l.item WHERE l.id = ?`,
            row.target_id,
          );
          if (link) owners.add(link.owner);
          if (
            link &&
            !link.revoked &&
            (link.expires === null || link.expires > now) &&
            !link.trashed &&
            (link.item_expires === null || link.item_expires > now)
          ) {
            const issued = issuePickupCode(ctx.db, ctx.secrets, "share", row.target_id, length);
            ctx.db.run("UPDATE links SET code_hash = ? WHERE id = ?", issued.codeHash, row.target_id);
          }
          break;
        }
        case "request": {
          const request = ctx.db.get<{ owner: string; closed: number | null; expires: number }>(
            "SELECT owner, closed, expires FROM requests WHERE id = ?",
            row.target_id,
          );
          if (request) owners.add(request.owner);
          if (request && request.closed === null && request.expires > now) {
            const issued = issuePickupCode(ctx.db, ctx.secrets, "request", row.target_id, length);
            ctx.db.run("UPDATE requests SET code_hash = ? WHERE id = ?", issued.codeHash, row.target_id);
          }
          break;
        }
        case "invitation": {
          const invite = ctx.db.get<{ created_by: string; used: number | null; expires: number }>(
            "SELECT created_by, used, expires FROM invites WHERE id = ?",
            row.target_id,
          );
          if (invite) owners.add(invite.created_by);
          if (invite && invite.used === null && invite.expires > now) {
            const issued = issuePickupCode(ctx.db, ctx.secrets, "invitation", row.target_id, length);
            ctx.db.run("UPDATE invites SET code_hash = ? WHERE id = ?", issued.codeHash, row.target_id);
          }
          break;
        }
        case "device": {
          const login = ctx.db.get<{
            user_id: string;
            used: number | null;
            revoked: number | null;
            expires: number;
            session_expires: number | null;
            disabled: number;
          }>(
            `SELECT c.user_id, c.used, c.revoked, c.expires, s.expires AS session_expires, u.disabled
             FROM login_codes c LEFT JOIN sessions s ON s.token_hash = c.session_hash
             JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
            row.target_id,
          );
          if (login) owners.add(login.user_id);
          if (
            login &&
            login.used === null &&
            login.revoked === null &&
            login.expires > now &&
            login.session_expires !== null &&
            login.session_expires > now &&
            !login.disabled
          ) {
            const issued = issuePickupCode(ctx.db, ctx.secrets, "device", row.target_id, length);
            ctx.db.run("UPDATE login_codes SET code_hash = ? WHERE id = ?", issued.codeHash, row.target_id);
          }
          break;
        }
        case "nearby": {
          const invite = ctx.db.get<{ user_id: string; expires: number }>(
            "SELECT user_id, expires FROM nearby_invites WHERE id = ?",
            row.target_id,
          );
          if (invite) owners.add(invite.user_id);
          if (invite && invite.expires > now) {
            const issued = issuePickupCode(ctx.db, ctx.secrets, "nearby", row.target_id, length);
            ctx.db.run("UPDATE nearby_invites SET code_hash = ? WHERE id = ?", issued.codeHash, row.target_id);
          }
          break;
        }
      }
    }

    ctx.db.setSetting(SETTING, String(preferredLength));
    ctx.db.setSetting(EFFECTIVE_SETTING, String(length));
    ctx.db.setSetting(RECOVERY_BLOCKED_SETTING, "0");
    ctx.db.setSetting(RESOLUTION_UNAVAILABLE_SETTING, "0");
  });

  for (const owner of owners) ctx.events.publish(owner, "account", "links", "items", "requests", "devices", "nearby");
  ctx.events.broadcast("codes");
  return true;
}

/** Changes the administrator's preference while keeping an active security override in force. */
export function setPickupCodePreference(ctx: Context, length: CodeLength, now = Date.now()) {
  const previousPreference = preferredCodeLengthOf(ctx.db);
  if (length !== previousPreference) {
    ctx.db.setSetting(RECOVERY_BLOCKED_SETTING, "0");
    ctx.db.setSetting(RESOLUTION_UNAVAILABLE_SETTING, "0");
    // Code entry shows the preference, even while a security override keeps the length.
    ctx.events.broadcast("codes");
  }
  const effective = length === 4 && pickupCodeHeightened(ctx, now) ? 6 : length;
  if (effective === codeLengthOf(ctx.db)) {
    if (preferredCodeLengthOf(ctx.db) !== length) ctx.db.tx(() => ctx.db.setSetting(SETTING, String(length)));
    return false;
  }
  try {
    return rotatePickupCodes(ctx, effective, length);
  } catch (error) {
    if (codeLengthOf(ctx.db) === 4 && effective === 6 && (error as { status?: number }).status === 409) {
      ctx.db.setSetting(RESOLUTION_UNAVAILABLE_SETTING, "1");
      ctx.events.broadcast("codes");
    }
    throw error;
  }
}

/** Applies the temporary six-digit mode, or restores the preference after sustained quiet. */
export function reconcilePickupCodeMode(ctx: Context, now = Date.now()) {
  const preferred = preferredCodeLengthOf(ctx.db);
  const desired = preferred === 4 && pickupCodeHeightened(ctx, now) ? 6 : preferred;
  const current = codeLengthOf(ctx.db);
  if (current === desired) return false;
  if (current === 4 && desired === 6 && ctx.db.setting(RESOLUTION_UNAVAILABLE_SETTING) === "1") return false;
  if (current === 6 && desired === 4 && ctx.db.setting(RECOVERY_BLOCKED_SETTING) === "1") return false;
  try {
    return rotatePickupCodes(ctx, desired, preferred);
  } catch (error) {
    // Numeric codes use permanent tombstones. If the four-digit namespace is exhausted, the
    // existing six-digit assignments remain active and links/QR URLs stay untouched.
    if ((error as { status?: number }).status === 409 && current === 6 && desired === 4) {
      ctx.db.setSetting(RECOVERY_BLOCKED_SETTING, "1");
      ctx.events.broadcast("codes");
      return false;
    }
    if ((error as { status?: number }).status === 409 && current === 4 && desired === 6) {
      ctx.db.setSetting(RESOLUTION_UNAVAILABLE_SETTING, "1");
      ctx.events.broadcast("codes");
      return false;
    }
    throw error;
  }
}

/** Returns a replacement only to the owner of the original recipient. */
export function currentOwnedPickupCode(ctx: Context, memberId: string, rawCode: string): string | null {
  if (ctx.db.setting(RESOLUTION_UNAVAILABLE_SETTING) === "1") return null;
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const entry = ctx.db.get<{ kind: PickupCodeKind; target_id: string }>(
    "SELECT kind, target_id FROM pickup_codes WHERE code_hash = ?",
    ctx.secrets.pickupCodeHash(code),
  );
  if (!entry) return null;
  const now = Date.now();
  let owner: string | undefined;
  let usable = false;
  switch (entry.kind) {
    case "share": {
      const row = ctx.db.get<{ owner: string }>(
        `SELECT l.owner FROM links l JOIN items i ON i.id = l.item JOIN users u ON u.id = l.owner
         WHERE l.id = ? AND l.revoked IS NULL AND (l.expires IS NULL OR l.expires > ?) AND u.disabled = 0
           AND i.trashed IS NULL AND (i.expires IS NULL OR i.expires > ?)`,
        entry.target_id,
        now,
        now,
      );
      owner = row?.owner;
      usable = !!row;
      break;
    }
    case "request": {
      const row = ctx.db.get<{ owner: string }>(
        `SELECT r.owner FROM requests r JOIN users u ON u.id = r.owner
         WHERE r.id = ? AND r.closed IS NULL AND r.expires > ? AND u.disabled = 0`,
        entry.target_id,
        now,
      );
      owner = row?.owner;
      usable = !!row;
      break;
    }
    case "invitation": {
      const row = ctx.db.get<{ created_by: string }>(
        "SELECT created_by FROM invites WHERE id = ? AND used IS NULL AND expires > ?",
        entry.target_id,
        now,
      );
      owner = row?.created_by;
      usable = !!row;
      break;
    }
    case "device": {
      const row = ctx.db.get<{ user_id: string }>(
        `SELECT c.user_id FROM login_codes c JOIN sessions s ON s.token_hash = c.session_hash
         JOIN users u ON u.id = c.user_id WHERE c.id = ? AND c.used IS NULL AND c.revoked IS NULL
           AND c.expires > ? AND s.expires > ? AND u.disabled = 0`,
        entry.target_id,
        now,
        now,
      );
      owner = row?.user_id;
      usable = !!row;
      break;
    }
    case "nearby": {
      const row = ctx.db.get<{ user_id: string }>(
        `SELECT n.user_id FROM nearby_invites n JOIN users u ON u.id = n.user_id
         WHERE n.id = ? AND n.expires > ? AND u.disabled = 0`,
        entry.target_id,
        now,
      );
      owner = row?.user_id;
      usable = !!row;
      break;
    }
  }
  if (!usable || owner !== memberId) return null;
  return getPickupCode(ctx.db, ctx.secrets, entry.kind, entry.target_id);
}
