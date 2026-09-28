import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { leaseRenewalMs, principalKey, type Context, type Grant, type Member, type Principal } from "../../context.ts";
import type { ChangeEvent, SessionEnded, StreamLimited, StreamReady } from "../../../shared/model.ts";
import { grantFor, memberFromToken, requireMember, sessionCookie } from "../../lib/auth.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { sha256 } from "../../lib/secrets.ts";

type EndReason = SessionEnded["reason"];
/** Why a user's sessions were just revoked, when the database alone can't tell. */
export type EndHint = { userId: string; reason: EndReason };

type Stream = {
  userId: string;
  /** Set for member streams: the device counts as online while it holds one. */
  deviceId: string | null;
  /** A member session or guest grant may hold only a bounded number of event streams. */
  capKey: string;
  cap: number;
  /** Shared across an origin's tabs and grants; an admission hint that grants no authority. */
  browser: string | null;
  res: ServerResponse;
  /** Null while the credential still works; otherwise why it stopped. */
  ended: (hint: EndHint | undefined) => EndReason | null;
  tab: string | null;
  principal: Principal;
  unsubscribe: () => void;
};

type PollingPresence = Pick<Stream, "userId" | "capKey" | "ended"> & { deviceId: string; expires: number };

/**
 * A device is online while it holds a live member stream or keeps making authenticated polling
 * probes. One timer revalidates both forms of presence and writes stream beats; durable tab leases
 * and device timestamps are renewed at a slower cadence.
 */
class Streams {
  private readonly open = new Set<Stream>();
  private readonly perDevice = new Map<string, number>();
  private readonly polling = new Map<string, PollingPresence>();
  private readonly pollingDevices = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private readonly ctx: Context;
  private flushed = Date.now();
  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Well inside the tab lease, so one missed beat never abandons a tab's transfers. */
  get beatMs() {
    return Math.min(20_000, this.ctx.config.tabLeaseMs / 3);
  }

  /** Writes are less frequent than wire keep-alives, with ample room before lease expiry. */
  get durableMs() {
    return leaseRenewalMs(this.ctx);
  }

  online(deviceId: string) {
    this.recheck();
    return this.hasPresence(deviceId);
  }

  private hasPresence(deviceId: string) {
    return (this.perDevice.get(deviceId) ?? 0) > 0 || (this.pollingDevices.get(deviceId) ?? 0) > 0;
  }

  /** Revalidate once for the whole operation, then provide constant-time device lookups. */
  presence(userId: string) {
    this.recheck(undefined, userId);
    return new Set(
      [...this.open, ...this.polling.values()].filter((s) => s.userId === userId && s.deviceId).map((s) => s.deviceId!),
    );
  }

  /** Admission never evicts an existing tab: that would rotate every reconnect around the cap. */
  canAdd(spec: Pick<Stream, "capKey" | "cap" | "browser">) {
    this.recheck();
    // Without shared storage, short probes still renew leases and refresh member views. Never
    // occupy an unbounded share of HTTP/1's six sockets across unrelated guest grants.
    if (!spec.browser) return false;
    let count = 0;
    let browserCount = 0;
    for (const current of this.open) {
      if (current.capKey === spec.capKey) count++;
      if (current.browser === spec.browser) browserCount++;
    }
    return count < spec.cap && browserCount < 4;
  }

  add(stream: Stream) {
    this.open.add(stream);
    if (stream.deviceId) {
      const count = (this.perDevice.get(stream.deviceId) ?? 0) + 1;
      this.perDevice.set(stream.deviceId, count);
      if (count === 1) this.ctx.events.publish(stream.userId, "devices");
    }
    this.startTimer();
  }

  /** A successful member probe stays reachable for one missed poll, but never indefinitely. */
  probe(spec: Pick<Stream, "userId" | "deviceId" | "capKey" | "ended">) {
    if (!spec.deviceId) return;
    const previous = this.polling.get(spec.capKey);
    if (previous && previous.deviceId !== spec.deviceId) this.removePolling(previous);
    const wasOnline = this.hasPresence(spec.deviceId);
    // One entry per authenticated session, not per caller-supplied tab or browser ID.
    this.polling.set(spec.capKey, { ...spec, deviceId: spec.deviceId, expires: Date.now() + this.beatMs * 2.5 });
    if (!previous || previous.deviceId !== spec.deviceId)
      this.pollingDevices.set(spec.deviceId, (this.pollingDevices.get(spec.deviceId) ?? 0) + 1);
    if (!wasOnline) this.ctx.events.publish(spec.userId, "devices");
    this.startTimer();
  }

  private removePolling(presence: PollingPresence) {
    this.polling.delete(presence.capKey);
    const count = (this.pollingDevices.get(presence.deviceId) ?? 1) - 1;
    if (count > 0) this.pollingDevices.set(presence.deviceId, count);
    else this.pollingDevices.delete(presence.deviceId);
    if (!this.hasPresence(presence.deviceId)) this.ctx.events.publish(presence.userId, "devices");
  }

  private startTimer() {
    this.timer ??= setInterval(() => {
      void this.ctx.operations
        .run(
          "Live connections",
          () => this.beat(),
          (error) => this.failed(error),
        )
        .catch((error) => this.failed(error));
    }, this.beatMs).unref();
  }

  private failed(error: unknown) {
    this.closeAll();
    // Logging is part of an asynchronous boundary too. Never let a failing sink reject the timer.
    try {
      this.ctx.log.error(
        { code: (error as { code?: string })?.code ?? "UNKNOWN" },
        "Live connections failed; streams closed",
      );
    } catch {
      // The operational failure is also retained in the bounded diagnostics above.
    }
  }

  /** Initial admission and overflow probes share the durable cadence without caching auth. */
  renew(spec: Pick<Stream, "tab" | "principal" | "deviceId">) {
    const now = Date.now();
    const lease = spec.tab
      ? this.ctx.db.get<{ principal: string; lease_expires: number; closed: number | null }>(
          "SELECT principal, lease_expires, closed FROM tabs WHERE id = ?",
          spec.tab,
        )
      : undefined;
    if (lease && (lease.closed !== null || lease.principal !== principalKey(spec.principal)))
      fail(409, "This tab was closed, so its transfer was cancelled.");
    const renewTab = spec.tab && (!lease || lease.lease_expires <= now + this.ctx.config.tabLeaseMs - this.durableMs);
    const renewDevice =
      spec.deviceId &&
      (this.ctx.db.value<number>("SELECT seen FROM devices WHERE id = ?", spec.deviceId) ?? 0) <= now - this.durableMs;
    if (!renewTab && !renewDevice) return;
    this.ctx.db.tx(() => {
      if (renewTab) this.ctx.transfers.renewTab(spec.tab!, spec.principal);
      if (renewDevice) this.ctx.db.run("UPDATE devices SET seen = ? WHERE id = ?", now, spec.deviceId);
    });
  }

  write(stream: Stream, data: string) {
    try {
      if (stream.res.write(data)) return;
    } catch {
      // A broken or stalled connection must not break the event bus or grow an unbounded buffer.
    }
    stream.res.destroy();
    this.end(stream);
  }

  /** With a reason, a member stream is told why before it closes, so its tab can end the session. */
  end(stream: Stream, reason?: EndReason) {
    if (!this.open.delete(stream)) return;
    stream.unsubscribe();
    if (stream.deviceId) {
      const count = (this.perDevice.get(stream.deviceId) ?? 1) - 1;
      if (count > 0) this.perDevice.set(stream.deviceId, count);
      else {
        this.perDevice.delete(stream.deviceId);
        this.ctx.events.publish(stream.userId, "devices");
      }
    }
    try {
      if (reason) {
        const event: SessionEnded = { reason };
        stream.res.write(`event: ended\ndata: ${JSON.stringify(event)}\n\n`);
      }
      stream.res.end();
    } catch {
      stream.res.destroy();
    }
  }

  /**
   * Ends streams whose session or grant is gone. Called right after sessions are revoked, with a
   * hint when the reason is not visible in the database (a password reset rather than a sign-out).
   */
  recheck(hint?: EndHint, userId?: string) {
    try {
      for (const presence of this.polling.values()) {
        if (userId && presence.userId !== userId) continue;
        if (presence.expires <= Date.now() || presence.ended(hint?.userId === presence.userId ? hint : undefined)) {
          this.removePolling(presence);
        }
      }
      for (const stream of [...this.open]) {
        if (userId && stream.userId !== userId) continue;
        const reason = stream.ended(hint?.userId === stream.userId ? hint : undefined);
        if (reason) this.end(stream, reason);
      }
    } catch (error) {
      // Failed validation cannot leave a possibly revoked subscription receiving private changes.
      this.closeAll();
      throw error;
    }
  }

  private beat() {
    this.recheck();
    const now = Date.now();
    if (this.open.size && now - this.flushed >= this.durableMs) {
      const tabs = new Set<string>();
      const devices = new Set<string>();
      const closed = new Set<string>();
      this.ctx.db.tx(() => {
        for (const stream of this.open) {
          if (stream.tab && !tabs.has(stream.tab)) {
            tabs.add(stream.tab);
            if (!this.ctx.transfers.renewTab(stream.tab, stream.principal)) closed.add(stream.tab);
          }
          if (stream.deviceId) devices.add(stream.deviceId);
        }
        for (const device of devices) this.ctx.db.run("UPDATE devices SET seen = ? WHERE id = ?", now, device);
      });
      // Commit before advancing the cadence or acknowledging life to any client.
      this.flushed = now;
      for (const stream of this.open) if (stream.tab && closed.has(stream.tab)) this.end(stream);
    }
    for (const stream of this.open) this.write(stream, "event: beat\ndata: {}\n\n");
  }

  closeAll() {
    const polling = [...this.polling.values()];
    this.polling.clear();
    this.pollingDevices.clear();
    for (const stream of [...this.open]) this.end(stream);
    for (const presence of polling) this.ctx.events.publish(presence.userId, "devices");
  }

  shutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.closeAll();
  }
}

const registry = new WeakMap<Context, Streams>();
export function streamsOf(ctx: Context): Streams {
  let streams = registry.get(ctx);
  if (!streams) registry.set(ctx, (streams = new Streams(ctx)));
  return streams;
}

const TAB = /^[A-Za-z0-9_-]{16,64}$/;
function tabOf(req: FastifyRequest): string | null {
  const tab = (req.query as { tab?: unknown }).tab;
  return typeof tab === "string" && TAB.test(tab) ? tab : null;
}

function browserOf(req: FastifyRequest): string | null {
  const browser = (req.query as { browser?: unknown }).browser;
  return typeof browser === "string" && TAB.test(browser) ? browser : null;
}

function openStream(ctx: Context, reply: FastifyReply, spec: Omit<Stream, "res" | "unsubscribe">, subscribe: boolean) {
  const streams = streamsOf(ctx);
  streams.renew(spec);
  const admitted = streams.canAdd(spec);
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  if (!admitted) {
    streams.probe(spec);
    const limited: StreamLimited = { retryMs: streams.beatMs };
    res.end(`event: limited\ndata: ${JSON.stringify(limited)}\n\n`);
    return;
  }
  const stream: Stream = {
    ...spec,
    res,
    unsubscribe: subscribe
      ? ctx.events.subscribe(spec.userId, (topics) => {
          const event: ChangeEvent = { topics };
          streams.write(stream, `event: change\ndata: ${JSON.stringify(event)}\n\n`);
        })
      : () => {},
  };
  // Taken once subscribed, and before this device is announced online: every change after it,
  // that announcement included, reaches this stream.
  const changes = ctx.events.stamp();
  res.on("close", () => streams.end(stream));
  res.on("error", () => streams.end(stream));
  streams.add(stream);
  const ready: StreamReady = { beatMs: streams.beatMs, changes };
  streams.write(stream, `event: ready\ndata: ${JSON.stringify(ready)}\n\n`);
}

function memberStream(ctx: Context, req: FastifyRequest, reply: FastifyReply) {
  const member: Member = requireMember(ctx, req);
  const token = req.cookies[sessionCookie(ctx, req)];
  const tab = tabOf(req);
  const expiresAt = () => ctx.db.value<number>("SELECT expires FROM sessions WHERE token_hash = ?", member.sessionHash);
  // Remembered so a session that expired and was then swept still reads as expired.
  const opened = expiresAt()!;
  const ended = (hint: EndHint | undefined): EndReason | null => {
    if (memberFromToken(ctx, token)?.sessionHash === member.sessionHash) return null;
    if (ctx.db.value("SELECT disabled FROM users WHERE id = ?", member.userId)) return "suspended";
    if (Date.now() >= (expiresAt() ?? opened)) return "expired";
    return hint?.reason ?? "signed-out";
  };
  openStream(
    ctx,
    reply,
    {
      userId: member.userId,
      deviceId: member.deviceId,
      capKey: `session:${member.sessionHash}`,
      cap: 4,
      browser: browserOf(req),
      ended,
      tab,
      principal: member,
    },
    true,
  );
}

function guestStream(ctx: Context, req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) {
  const requestId =
    ctx.db.value<string>("SELECT id FROM requests WHERE token_hash = ?", sha256(req.params.token)) ??
    notFound("That request");
  const grant: Grant = grantFor(ctx, req, requestId) ?? fail(401, "Open the request link again to continue.");
  const tab = tabOf(req);
  const ended = (): EndReason | null => {
    const now = Date.now();
    const valid = !!ctx.db.get(
      `SELECT 1 FROM guest_grants g JOIN requests r ON r.id = g.request_id JOIN users u ON u.id = r.owner
       WHERE g.token_hash = ? AND g.expires > ? AND r.closed IS NULL AND r.expires > ? AND u.disabled = 0`,
      grant.tokenHash,
      now,
      now,
    );
    // Tell the client to stop retrying when the grant is no longer usable.
    return valid ? null : "expired";
  };
  openStream(
    ctx,
    reply,
    {
      userId: grant.owner,
      deviceId: null,
      capKey: `grant:${grant.tokenHash}`,
      cap: 2,
      browser: browserOf(req),
      ended,
      tab,
      principal: grant,
    },
    false,
  );
}

export function registerStreams(app: FastifyInstance, ctx: Context) {
  app.get("/api/events", (req, reply) => memberStream(ctx, req, reply));
  app.get<{ Params: { token: string } }>("/api/r/:token/events", (req, reply) => guestStream(ctx, req, reply));
  app.addHook("preClose", () => Promise.resolve().then(() => streamsOf(ctx).shutdown()));
}
