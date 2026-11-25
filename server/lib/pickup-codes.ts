// Six-digit pickup codes: a quick way to hand over a link out loud. A code is a convenience for
// the day it's shown, never a long-lived key: it stops working a day after it's issued, and the
// owner's screen shows a fresh one whenever they look. The link and QR code stay the same.
//
// Every code is registered in `pickup_codes`. A retired code keeps its row for a cool-down, so a
// code someone remembers never opens another person's share; after that its digits are free
// again. The oldest row of each recipient stays as its history, so a recipient id is never reused.
import type { Context } from "../context.ts";
import type { Database } from "../db/database.ts";
import { fail, HttpError } from "./errors.ts";
import type { Secrets } from "./secrets.ts";
import { normalizeCode } from "./secrets.ts";
import { nthNewestFailure, recordFailure } from "./failures.ts";
import { CODE_LENGTH } from "../../shared/codes.ts";

export type PickupCodeKind = "share" | "request" | "invitation" | "device" | "nearby";

const DAY_MS = 86_400_000;
/** How long a code works after it's issued. Device and Nearby codes end sooner, with their recipient. */
export const CODE_LIFE_MS = DAY_MS;
/** How long a retired code's digits stay reserved before another recipient may get them. */
export const CODE_COOL_DOWN_MS = 30 * DAY_MS;
/**
 * How many candidates a new code may try before giving up. Nearly every first candidate is free;
 * the bound keeps a nearly full namespace from stalling the server while it scans.
 */
export const CODE_TRIES = 64;
/**
 * New codes one member's shares, requests, invitations and Nearby codes may get a day, counting
 * both new ones and the daily renewal of open ones. Each code holds its digits for a month, so
 * without a cap one member could use them all up for everyone. Device sign-in codes have their own.
 */
export const NEW_CODES_PER_DAY = 500;

/** The table holding each kind of recipient, with the hash of its current code. */
const TABLE: Record<PickupCodeKind, string> = {
  share: "links",
  request: "requests",
  invitation: "invites",
  device: "login_codes",
  nearby: "nearby_invites",
};
/** The column of each recipient's table naming the member it belongs to. */
const OWNER: Record<PickupCodeKind, string> = {
  share: "owner",
  request: "owner",
  invitation: "created_by",
  device: "user_id",
  nearby: "user_id",
};

type RegisteredCode = { code_hash: string; nonce: number; created: number };
export type IssuedCode = { code: string; codeHash: string; expires: number };

/**
 * The code at `nonce` in the target's sequence, or null when it no longer matches the digest it was
 * stored under: the server's secret key has changed since, so the owner gets a fresh code instead.
 */
function codeAt(secrets: Secrets, kind: PickupCodeKind, targetId: string, row: RegisteredCode) {
  const code = secrets.pickupCodeFor(kind, targetId, row.nonce);
  return secrets.pickupCodeHash(normalizeCode(code)!) === row.code_hash ? code : null;
}

/** The stored code while it works and still matches the secret key, or null. */
function working(
  secrets: Secrets,
  kind: PickupCodeKind,
  targetId: string,
  row: RegisteredCode | undefined,
  now: number,
) {
  if (!row || row.created + CODE_LIFE_MS <= now) return null;
  const code = codeAt(secrets, kind, targetId, row);
  return code ? { code, codeHash: row.code_hash, expires: row.created + CODE_LIFE_MS } : null;
}

/**
 * Counts a new recipient that needs a code against its member's daily allowance, or refuses it.
 * Call it inside the transaction that creates the recipient, so a refused one leaves no trace.
 */
export function countNewCode(ctx: Pick<Context, "db">, memberId: string, now = Date.now()) {
  if (!codeAllowance(ctx, memberId, now))
    fail(
      429,
      "You’ve made a lot of new shares, requests and Nearby codes today. Reuse one you already have, or try again tomorrow.",
    );
  recordFailure(ctx, "new-code", [memberId], now);
}

// The failures table is a day-long event log; this kind counts codes made, not wrong guesses.
const codeAllowance = (ctx: Pick<Context, "db">, memberId: string, now: number) =>
  nthNewestFailure(ctx, "new-code", memberId, now - DAY_MS, NEW_CODES_PER_DAY) === undefined;

const liveRow = (db: Database, kind: PickupCodeKind, targetId: string) =>
  db.get<RegisteredCode>(
    "SELECT code_hash, nonce, created FROM pickup_codes WHERE kind = ? AND target_id = ? AND retired IS NULL",
    kind,
    targetId,
  );

/**
 * The target's code while it still works, or a new one when it has expired (or never existed).
 * Callers update the target's own `code_hash` with the result; `livePickupCode` does it for them.
 */
export function issuePickupCode(
  db: Database,
  secrets: Secrets,
  kind: PickupCodeKind,
  targetId: string,
  now = Date.now(),
): IssuedCode {
  return db.tx(() => {
    const prior = liveRow(db, kind, targetId);
    const current = working(secrets, kind, targetId, prior, now);
    if (current) return current;
    if (prior) db.run("UPDATE pickup_codes SET retired = ? WHERE code_hash = ?", now, prior.code_hash);

    // Carry on from the target's last code, so its own recent codes aren't tried again.
    const size = 10 ** CODE_LENGTH;
    const last = db.value<number>(
      "SELECT max(nonce) FROM pickup_codes WHERE kind = ? AND target_id = ?",
      kind,
      targetId,
    );
    // One compiled lookup for the scan; nearly every first candidate is free.
    const holder = db.sqlite.prepare(
      "SELECT kind, target_id, ifnull(retired, created + ?) AS ended FROM pickup_codes WHERE code_hash = ?",
    );
    for (let i = 0; i < CODE_TRIES; i++) {
      const nonce = ((last ?? -1) + 1 + i) % size;
      const code = secrets.pickupCodeFor(kind, targetId, nonce);
      const codeHash = secrets.pickupCodeHash(normalizeCode(code)!);
      const held = holder.get(CODE_LIFE_MS, codeHash) as
        { kind: PickupCodeKind; target_id: string; ended: number } | undefined;
      if (held) {
        if (held.ended > now - CODE_COOL_DOWN_MS) continue;
        release(db, codeHash, held.kind, held.target_id);
      }
      db.run(
        "INSERT INTO pickup_codes(code_hash, kind, target_id, nonce, created) VALUES(?, ?, ?, ?, ?)",
        codeHash,
        kind,
        targetId,
        nonce,
        now,
      );
      return { code, codeHash, expires: now + CODE_LIFE_MS };
    }
    return fail(503, "Relay couldn’t find a free six-digit code just now, so nothing new was made. Try again later.");
  });
}

/** Frees a long-retired code's digits, keeping one row per recipient as its id history. */
function release(db: Database, codeHash: string, kind: PickupCodeKind, targetId: string) {
  const others = db.value<number>(
    "SELECT count(*) FROM pickup_codes WHERE kind = ? AND target_id = ? AND code_hash != ?",
    kind,
    targetId,
    codeHash,
  );
  if (others) db.run("DELETE FROM pickup_codes WHERE code_hash = ?", codeHash);
  else
    db.run(
      `UPDATE pickup_codes SET code_hash = 'released:' || lower(hex(randomblob(16))),
         retired = ifnull(retired, created + ?) WHERE code_hash = ?`,
      CODE_LIFE_MS,
      codeHash,
    );
}

/**
 * The code to show the owner of an open recipient: the current one, or a fresh one once it has
 * expired. Returns null for a recipient that's closed, so ended shares don't hold codes, and when a
 * fresh one can't be had today (its owner's allowance is spent, or no free code turned up), so the
 * screen shows no code rather than failing; the link and QR code still work.
 */
export function livePickupCode(
  ctx: Pick<Context, "db" | "secrets">,
  kind: PickupCodeKind,
  targetId: string,
  open = true,
  now = Date.now(),
): IssuedCode | null {
  const current = working(ctx.secrets, kind, targetId, liveRow(ctx.db, kind, targetId), now);
  if (current) return current;
  if (!open) return null;
  return ctx.db.tx(() => {
    const owner = ctx.db.value<string>(`SELECT ${OWNER[kind]} FROM ${TABLE[kind]} WHERE id = ?`, targetId);
    if (owner && !codeAllowance(ctx, owner, now)) return null;
    let issued: IssuedCode;
    try {
      issued = issuePickupCode(ctx.db, ctx.secrets, kind, targetId, now);
    } catch (error) {
      // Only retiring the expired code and freeing long-cooled ones happened, which is safe to keep.
      if (error instanceof HttpError && error.status === 503) return null;
      throw error;
    }
    if (owner) recordFailure(ctx, "new-code", [owner], now);
    ctx.db.run(`UPDATE ${TABLE[kind]} SET code_hash = ? WHERE id = ?`, issued.codeHash, targetId);
    return issued;
  });
}

/**
 * The target's code as last issued, working or not, without issuing a new one. Lists show it so
 * the owner's screen can ask for the working code (`currentOwnedPickupCode`) only when it shows it.
 */
export function lastPickupCode(ctx: Pick<Context, "db" | "secrets">, kind: PickupCodeKind, targetId: string) {
  const row = liveRow(ctx.db, kind, targetId);
  // A code from before a change of secret key reads as none, so the owner is given a fresh one.
  return row ? codeAt(ctx.secrets, kind, targetId, row) : null;
}

/** The recipient a working code names right now, if any. */
export function findPickupCode(db: Database, codeHash: string, now = Date.now()) {
  return db.get<{ kind: PickupCodeKind; target_id: string }>(
    "SELECT kind, target_id FROM pickup_codes WHERE code_hash = ? AND retired IS NULL AND created > ?",
    codeHash,
    now - CODE_LIFE_MS,
  );
}

/** Who owns a recipient and whether it is still open, or undefined when it is gone. */
function ownerOf(ctx: Context, kind: PickupCodeKind, targetId: string, now: number) {
  const open = (sql: string, ...params: (string | number)[]) =>
    ctx.db.get<{ owner: string; open: number }>(sql, ...params);
  switch (kind) {
    case "share":
      return open(
        `SELECT l.owner, (l.revoked IS NULL AND (l.expires IS NULL OR l.expires > ?) AND u.disabled = 0
             AND i.trashed IS NULL AND (i.expires IS NULL OR i.expires > ?)) AS open
         FROM links l JOIN items i ON i.id = l.item JOIN users u ON u.id = l.owner WHERE l.id = ?`,
        now,
        now,
        targetId,
      );
    case "request":
      return open(
        `SELECT r.owner, (r.closed IS NULL AND r.expires > ? AND u.disabled = 0) AS open
         FROM requests r JOIN users u ON u.id = r.owner WHERE r.id = ?`,
        now,
        targetId,
      );
    case "invitation":
      return open(
        "SELECT created_by AS owner, (used IS NULL AND expires > ?) AS open FROM invites WHERE id = ?",
        now,
        targetId,
      );
    case "device":
      return open(
        `SELECT c.user_id AS owner, (c.used IS NULL AND c.revoked IS NULL AND c.expires > ? AND s.expires > ?
             AND u.disabled = 0) AS open
         FROM login_codes c JOIN sessions s ON s.token_hash = c.session_hash JOIN users u ON u.id = c.user_id
         WHERE c.id = ?`,
        now,
        now,
        targetId,
      );
    case "nearby":
      return open(
        `SELECT n.user_id AS owner, (n.expires > ? AND u.disabled = 0) AS open
         FROM nearby_invites n JOIN users u ON u.id = n.user_id WHERE n.id = ?`,
        now,
        targetId,
      );
  }
}

/**
 * The working code for the recipient that `rawCode` once named, but only for its owner and only
 * while the recipient is open. A screen showing a code calls this so it never shows a dead one.
 */
export function currentOwnedPickupCode(ctx: Context, memberId: string, rawCode: string, now = Date.now()) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const entry = ctx.db.get<{ kind: PickupCodeKind; target_id: string }>(
    "SELECT kind, target_id FROM pickup_codes WHERE code_hash = ?",
    ctx.secrets.pickupCodeHash(code),
  );
  if (!entry) return null;
  const target = ownerOf(ctx, entry.kind, entry.target_id, now);
  if (!target?.open || target.owner !== memberId) return null;
  return livePickupCode(ctx, entry.kind, entry.target_id, true, now);
}
