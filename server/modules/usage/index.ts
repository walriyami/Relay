// Usage statistics: what each member uploaded, downloaded and shared, hour by hour, and what their
// storage held, for their own Usage page and for Admin. Counting happens in memory and is written in
// small batches, so a busy upload or a page of thumbnails costs no extra database writes.
import type { FastifyInstance } from "fastify";
import type { Context, UsageMeter } from "../../context.ts";
import { api } from "../../../shared/api.ts";
import type {
  AdminUsageReport,
  StorageKind,
  StorageSummary,
  UsageBucket,
  UsageCounts,
  UsageRange,
  UsageReport,
} from "../../../shared/model.ts";
import { route } from "../../lib/http.ts";
import { DAY_MS } from "../../lib/time.ts";
import { capacityOf } from "../admin/settings.ts";
import { memberLimitsOf } from "../auth/member-limits.ts";
import { usageOf } from "../auth/sessions.ts";

const HOUR_MS = 3_600_000;
/** Counts wait at most this long in memory before they are written. */
const FLUSH_MS = 5_000;
const MAX_RETRY_MS = 60_000;
// An outage must not turn optional reporting into unbounded process memory.
const MAX_BUFFERED_ROWS = 16_384;
/** History is kept long enough to compare a year with the one before it. */
const KEEP_HOURS = 26 * 31 * 24;
/** Stored bytes are sampled again after this long even when unchanged, so pruning never loses the last sample. */
const RESAMPLE_HOURS = 30 * 24;

const COUNTS = ["uploaded", "received", "downloaded", "shared", "files", "visitors", "downloads"] as const;
const zero = (): UsageCounts => ({
  uploaded: 0,
  received: 0,
  downloaded: 0,
  shared: 0,
  files: 0,
  visitors: 0,
  downloads: 0,
});
const hourOf = (time: number) => Math.floor(time / HOUR_MS);

export function createUsageMeter(ctx: Context): UsageMeter {
  const counts = new Map<string, { userId: string; hour: number; counts: UsageCounts }>();
  const traffic = new Map<number, { requests: number; failures: number }>();
  let timer: NodeJS.Timeout | null = null;
  let retryMs = FLUSH_MS;
  let closed = false;
  let failed = false;
  let discarded = 0;

  const admit = () => {
    if (counts.size + traffic.size < MAX_BUFFERED_ROWS) return true;
    if (!discarded)
      ctx.log.error("usage buffer is full; new reporting samples will be discarded until storage recovers");
    discarded++;
    return false;
  };

  const schedule = () => {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        flush();
      } catch (error) {
        ctx.log.warn({ err: error }, "usage statistics could not be written");
      }
    }, retryMs);
    timer.unref();
  };

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!counts.size && !traffic.size) return;
    try {
      ctx.db.tx(() => {
        for (const { userId, hour, counts: c } of counts.values())
          ctx.db.run(
            `INSERT INTO usage(user_id, hour, ${COUNTS.join(", ")})
           SELECT ?, ?, ${COUNTS.map(() => "?").join(", ")} WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
           ON CONFLICT(user_id, hour) DO UPDATE SET ${COUNTS.map((k) => `${k} = ${k} + excluded.${k}`).join(", ")}`,
            userId,
            hour,
            ...COUNTS.map((k) => c[k]),
            userId,
          );
        for (const [hour, t] of traffic)
          ctx.db.run(
            `INSERT INTO traffic(hour, requests, failures) VALUES(?, ?, ?)
           ON CONFLICT(hour) DO UPDATE SET requests = requests + excluded.requests, failures = failures + excluded.failures`,
            hour,
            t.requests,
            t.failures,
          );
      });
      // The transaction is synchronous. No event can arrive between its commit and these clears.
      counts.clear();
      traffic.clear();
      failed = false;
      retryMs = FLUSH_MS;
    } catch (error) {
      failed = true;
      retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
      schedule();
      throw error;
    }
  }

  return {
    add(userId, add) {
      if (closed || !Object.values(add).some((n) => n)) return;
      const hour = hourOf(Date.now());
      const sample = { ...add };
      // Logical events inside a transaction count only once it commits, at the time they occurred.
      ctx.db.afterCommit(() => {
        if (closed) return;
        const key = `${userId}:${hour}`;
        const existing = counts.get(key);
        if (!existing && !admit()) return;
        const row = existing ?? { userId, hour, counts: zero() };
        for (const k of COUNTS) row.counts[k] += sample[k] ?? 0;
        counts.set(key, row);
        schedule();
      });
    },
    request(failed) {
      if (closed) return;
      const hour = hourOf(Date.now());
      const existing = traffic.get(hour);
      if (!existing && !admit()) return;
      const row = existing ?? { requests: 0, failures: 0 };
      row.requests++;
      if (failed) row.failures++;
      traffic.set(hour, row);
      schedule();
    },
    flush,
    status: () => ({ pending: counts.size + traffic.size, failed, discarded }),
    close() {
      closed = true;
      flush();
    },
    sweep(now) {
      flush();
      const hour = hourOf(now);
      ctx.db.tx(() => {
        ctx.db.run(
          `WITH last AS (
             SELECT user_id, max(hour) AS hour, stored FROM usage
             WHERE stored IS NOT NULL AND hour > ? GROUP BY user_id
           )
           INSERT INTO usage(user_id, hour, stored)
           SELECT u.id, ?, u.bytes_used FROM users u LEFT JOIN last l ON l.user_id = u.id
           WHERE l.hour IS NULL OR l.stored != u.bytes_used OR l.hour <= ?
           ON CONFLICT(user_id, hour) DO UPDATE SET stored = excluded.stored`,
          hour - RESAMPLE_HOURS - 24,
          hour,
          hour - RESAMPLE_HOURS,
        );
        ctx.db.run("DELETE FROM usage WHERE hour < ?", hour - KEEP_HOURS);
        ctx.db.run("DELETE FROM traffic WHERE hour < ?", hour - KEEP_HOURS);
      });
    },
  };
}

/** Where a range's days or months start, in the viewer's time zone (`tz`: minutes east of UTC). */
export function periodsOf(range: UsageRange, tz: number, now: number) {
  const offset = tz * 60_000;
  if (range === "12m") {
    const local = new Date(now + offset);
    const month = (n: number) => Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + n, 1) - offset;
    return {
      starts: Array.from({ length: 12 }, (_, i) => month(i - 11)),
      end: month(1),
      previous: month(-23),
    };
  }
  const days = Number(range.slice(0, -1));
  const today = Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
  const first = today - (days - 1) * DAY_MS;
  return {
    starts: Array.from({ length: days }, (_, i) => first + i * DAY_MS),
    end: today + DAY_MS,
    previous: first - days * DAY_MS,
  };
}

type HourRow = UsageCounts & { hour: number };
const SUMS = COUNTS.map((k) => `ifnull(sum(${k}), 0) AS ${k}`).join(", ");

/** Which period each hour falls in. Periods are sorted; hours before the first are dropped. */
function periodIndex(starts: number[], time: number) {
  let index = -1;
  for (let i = 0; i < starts.length && starts[i] <= time; i++) index = i;
  return index;
}

/**
 * The storage held at the end of each period: the last sample taken before it ended, per member,
 * added up. The current period shows what is held right now.
 */
function storedAtEnds(ctx: Context, starts: number[], end: number, userId: string | null, now: number) {
  const first = hourOf(starts[0]);
  const owner = userId === null ? "" : "AND user_id = ?";
  const args = userId === null ? [] : [userId];
  const samples = ctx.db.all<{ user_id: string; hour: number; stored: number }>(
    `SELECT user_id, max(hour) AS hour, stored FROM usage WHERE stored IS NOT NULL AND hour < ? ${owner} GROUP BY user_id
     UNION ALL
     SELECT user_id, hour, stored FROM usage WHERE stored IS NOT NULL AND hour >= ? AND hour < ? ${owner}
     ORDER BY hour`,
    first,
    ...args,
    first,
    hourOf(end) + 1,
    ...args,
  );
  const held = new Map<string, number>();
  let total = 0;
  let next = 0;
  const current = ctx.db.value<number>(
    `SELECT ifnull(sum(bytes_used), 0) FROM users ${userId === null ? "" : "WHERE id = ?"}`,
    ...args,
  )!;
  return starts.map((start, i) => {
    const until = starts[i + 1] ?? end;
    if (start <= now && now < until) return current;
    while (next < samples.length && samples[next].hour * HOUR_MS < until) {
      const sample = samples[next++];
      total += sample.stored - (held.get(sample.user_id) ?? 0);
      held.set(sample.user_id, sample.stored);
    }
    return until > now ? 0 : total;
  });
}

const DOCUMENT =
  /^(text\/|application\/(pdf|json|xml|rtf|msword|vnd\.ms-|vnd\.openxmlformats-officedocument|vnd\.oasis\.opendocument|epub\+zip|vnd\.apple\.(pages|numbers|keynote)))/;
const ARCHIVE =
  /^application\/(zip|x-zip-compressed|x-tar|gzip|x-gzip|x-7z-compressed|x-rar-compressed|vnd\.rar|x-bzip2?|x-xz|zstd|x-zstd|x-apple-diskimage|x-iso9660-image|vnd\.android\.package-archive|java-archive)$/;
export function kindOf(mime: string): StorageKind {
  const type = mime.split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return "images";
  if (type.startsWith("video/")) return "videos";
  if (type.startsWith("audio/")) return "audio";
  if (ARCHIVE.test(type)) return "archives";
  if (DOCUMENT.test(type)) return "documents";
  return "other";
}
const KINDS: StorageKind[] = ["images", "videos", "audio", "documents", "archives", "other"];

function storageOf(ctx: Context, userId: string | null): StorageSummary {
  const owner = userId === null ? "" : "AND n.owner = ?";
  const args = userId === null ? [] : [userId];
  const kinds = new Map(KINDS.map((kind) => [kind, { kind, bytes: 0, files: 0 }]));
  let trash = 0;
  for (const row of ctx.db.all<{ mime: string; trashed: number; bytes: number; files: number }>(
    `SELECT n.mime, i.trashed IS NOT NULL AS trashed, sum(n.size) AS bytes, sum(n.kind = 'file') AS files
     FROM nodes n JOIN items i ON i.id = n.item
     WHERE n.state = 'ready' AND n.kind != 'folder' ${owner}
     GROUP BY n.mime, i.trashed IS NOT NULL`,
    ...args,
  )) {
    if (row.trashed) trash += row.bytes;
    else {
      const kind = kinds.get(kindOf(row.mime))!;
      kind.bytes += row.bytes;
      kind.files += row.files;
    }
  }
  return {
    used: ctx.db.value<number>(
      `SELECT ifnull(sum(bytes_used), 0) FROM users ${userId === null ? "" : "WHERE id = ?"}`,
      ...args,
    )!,
    reserved: ctx.db.value<number>(
      `SELECT ifnull(sum(size), 0) FROM nodes n WHERE state = 'pending' ${owner}`,
      ...args,
    )!,
    trash,
    kinds: [...kinds.values()],
  };
}

function countsOf(ctx: Context, userId: string | null, now: number) {
  const where = (column: string) => (userId === null ? "" : `AND ${column} = ?`);
  const args = userId === null ? [] : [userId];
  return {
    items: ctx.db.value<number>(`SELECT count(*) FROM items WHERE trashed IS NULL ${where("owner")}`, ...args)!,
    files: ctx.db.value<number>(
      `SELECT count(*) FROM nodes n JOIN items i ON i.id = n.item
       WHERE n.kind = 'file' AND n.state = 'ready' AND i.trashed IS NULL ${where("n.owner")}`,
      ...args,
    )!,
    links: ctx.db.value<number>(
      `SELECT count(*) FROM links l JOIN items i ON i.id = l.item
       WHERE l.revoked IS NULL AND (l.expires IS NULL OR l.expires > ?)
         AND i.trashed IS NULL AND (i.expires IS NULL OR i.expires > ?) ${where("l.owner")}`,
      now,
      now,
      ...args,
    )!,
    requests: ctx.db.value<number>(
      `SELECT count(*) FROM requests WHERE closed IS NULL AND expires > ? ${where("owner")}`,
      now,
      ...args,
    )!,
  };
}

/** The periods of a range and their counts, the totals, and the same span just before for comparison. */
function reportOf(ctx: Context, userId: string | null, range: UsageRange, tz: number, now: number) {
  ctx.usage.flush();
  const { starts, end, previous } = periodsOf(range, tz, now);
  const owner = userId === null ? "" : "AND user_id = ?";
  const args = userId === null ? [] : [userId];
  const buckets: UsageBucket[] = starts.map((start) => ({ start, stored: 0, ...zero() }));
  for (const row of ctx.db.all<HourRow>(
    `SELECT hour, ${SUMS} FROM usage WHERE hour >= ? AND hour < ? ${owner} GROUP BY hour`,
    hourOf(starts[0]),
    hourOf(end),
    ...args,
  )) {
    const bucket = buckets[periodIndex(starts, row.hour * HOUR_MS)];
    if (bucket) for (const k of COUNTS) bucket[k] += row[k];
  }
  storedAtEnds(ctx, starts, end, userId, now).forEach((stored, i) => (buckets[i].stored = stored));
  const totals = zero();
  for (const bucket of buckets) for (const k of COUNTS) totals[k] += bucket[k];
  const before = ctx.db.get<UsageCounts>(
    `SELECT ${SUMS} FROM usage WHERE hour >= ? AND hour < ? ${owner}`,
    hourOf(previous),
    hourOf(starts[0]),
    ...args,
  )!;
  return {
    range,
    buckets,
    totals,
    previous: before,
    storage: storageOf(ctx, userId),
    counts: countsOf(ctx, userId, now),
    periods: { starts, end },
  };
}

export function registerUsage(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.usage, ({ member, query }): UsageReport => {
    const now = Date.now();
    const { periods: _, ...report } = reportOf(ctx, member.userId, query.range, query.tz, now);
    const largest = ctx.db.all<{ id: string; bytes: number }>(
      `SELECT i.id, sum(n.size) AS bytes FROM items i JOIN nodes n ON n.item = i.id
       WHERE i.owner = ? AND i.trashed IS NULL AND n.state = 'ready'
       GROUP BY i.id HAVING bytes > 0 ORDER BY bytes DESC, i.id LIMIT 5`,
      member.userId,
    );
    const summaries = ctx.library.summaries(largest.map((item) => item.id));
    return {
      ...report,
      available: usageOf(ctx, member.userId).available,
      limit: memberLimitsOf(ctx, member.userId).storage,
      largest: largest.map((item) => ({ ...item, name: summaries.get(item.id)?.name ?? "" })),
    };
  });

  route(app, ctx, api.admin.usage, ({ query }): AdminUsageReport => {
    const now = Date.now();
    const { periods, ...report } = reportOf(ctx, null, query.range, query.tz, now);
    const traffic = periods.starts.map(() => ({ requests: 0, failures: 0 }));
    for (const row of ctx.db.all<{ hour: number; requests: number; failures: number }>(
      "SELECT hour, requests, failures FROM traffic WHERE hour >= ? AND hour < ?",
      hourOf(periods.starts[0]),
      hourOf(periods.end),
    )) {
      const bucket = traffic[periodIndex(periods.starts, row.hour * HOUR_MS)];
      if (!bucket) continue;
      bucket.requests += row.requests;
      bucket.failures += row.failures;
    }
    const totals = new Map(
      ctx.db
        .all<HourRow & { user_id: string }>(
          `SELECT user_id, ${SUMS} FROM usage WHERE hour >= ? AND hour < ? GROUP BY user_id`,
          hourOf(periods.starts[0]),
          hourOf(periods.end),
        )
        .map(({ user_id, ...counts }) => [user_id, counts]),
    );
    const members = ctx.db
      .all<{ id: string; username: string; display_name: string | null; bytes_used: number }>(
        "SELECT id, username, display_name, bytes_used FROM users ORDER BY created",
      )
      .map((user) => {
        const own = totals.get(user.id);
        return {
          id: user.id,
          username: user.username,
          name: user.display_name,
          totals: own ? (Object.fromEntries(COUNTS.map((k) => [k, own[k]])) as UsageCounts) : zero(),
          used: user.bytes_used,
        };
      });
    return { ...report, capacity: capacityOf(ctx), traffic, members };
  });
}
