// The administrator's history of this Relay: who joined, left or was suspended, what members sent
// and shared, failed sign-ins and errors. Modules record events as they happen (inside their own
// transactions, so an undone action leaves no trace); Admin reads them newest first, filtered.
import type { FastifyInstance } from "fastify";
import { api } from "../../../shared/api.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import {
  HISTORY_GROUP_OF,
  type HistoryEntry,
  type HistoryEvent,
  type HistoryKind,
  type HistoryPage,
} from "../../../shared/model.ts";
import type { Context } from "../../context.ts";
import { route } from "../../lib/http.ts";
import { DAY_MS } from "../../lib/time.ts";

/** Entries older than this are deleted by the sweep. */
export const HISTORY_DAYS = 90;
/** Repeats with the same key within this long add to one entry. */
const DEDUPE_MS = 3_600_000;

/**
 * Records an event about `userId` (null: about no account, or one that no longer exists). Repeats
 * with the same `dedupe` key within an hour add to one entry instead of a new one. Never throws:
 * a full or failing history must not stop the action it describes.
 */
export function recordHistory(ctx: Context, event: HistoryEvent, userId: string | null = null, dedupe?: string) {
  try {
    const now = Date.now();
    const repeated =
      dedupe &&
      ctx.db.run(
        "UPDATE history SET count = count + 1, last = ? WHERE dedupe = ? AND created > ? AND kind = ?",
        now,
        dedupe,
        now - DEDUPE_MS,
        event.kind,
      ).changes;
    if (!repeated)
      ctx.db.run(
        "INSERT INTO history(id, kind, user_id, created, last, count, dedupe, data) VALUES(?, ?, ?, ?, ?, 1, ?, ?)",
        uuidv7(now),
        event.kind,
        userId,
        now,
        now,
        dedupe ?? null,
        JSON.stringify(event),
      );
    for (const { id } of ctx.db.all<{ id: string }>("SELECT id FROM users WHERE admin = 1"))
      ctx.events.publish(id, "history");
  } catch (error) {
    ctx.log.warn({ err: error, kind: event.kind }, "history entry not saved");
  }
}

/** The member's username now, for events recorded by id. */
export const usernameOf = (ctx: Context, userId: string) =>
  ctx.db.value<string>("SELECT username FROM users WHERE id = ?", userId) ?? "";

export function sweepHistory(ctx: Context, now: number) {
  return ctx.db.deleteBatched("history", "created <= ?", now - HISTORY_DAYS * DAY_MS);
}

export function registerHistory(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.admin.history, ({ query }): HistoryPage => {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.group) {
      const kinds = (Object.keys(HISTORY_GROUP_OF) as HistoryKind[]).filter((k) => HISTORY_GROUP_OF[k] === query.group);
      where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      args.push(...kinds);
    }
    if (query.member) {
      where.push("user_id = ?");
      args.push(query.member);
    }
    const rows = ctx.db.all<{
      id: string;
      user_id: string | null;
      created: number;
      last: number;
      count: number;
      data: string;
    }>(
      `SELECT id, user_id, created, last, count, data FROM history ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created DESC, rowid DESC LIMIT ?`,
      ...args,
      query.limit + 1,
    );
    return {
      entries: rows.slice(0, query.limit).map((row): HistoryEntry => ({
        ...(JSON.parse(row.data) as HistoryEvent),
        id: row.id,
        userId: row.user_id,
        created: row.created,
        last: row.last,
        count: row.count,
      })),
      more: rows.length > query.limit,
    };
  });
}
