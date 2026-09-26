import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Context, Grant, Member } from "../../context.ts";
import type { ChangeEvent, SessionEnded, StreamReady } from "../../../shared/model.ts";
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
  res: ServerResponse;
  /** Null while the credential still works; otherwise why it stopped. */
  ended: (hint: EndHint | undefined) => EndReason | null;
  renew: () => void;
  unsubscribe: () => void;
};

/**
 * Open event streams of one instance and the presence derived from them. A device is online exactly
 * while it holds at least one live member stream. One timer re-validates every stream, writes the
 * beat event and renews the stream's tab lease.
 */
class Streams {
  private readonly open = new Set<Stream>();
  private readonly perDevice = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private readonly ctx: Context;
  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Well inside the tab lease, so one missed beat never abandons a tab's transfers. */
  get beatMs() {
    return Math.min(20_000, this.ctx.config.tabLeaseMs / 3);
  }

  online(deviceId: string) {
    this.recheck();
    return (this.perDevice.get(deviceId) ?? 0) > 0;
  }

  add(stream: Stream) {
    this.recheck();
    const samePrincipal = [...this.open].filter((current) => current.capKey === stream.capKey);
    while (samePrincipal.length >= stream.cap) this.end(samePrincipal.shift()!);
    this.open.add(stream);
    if (stream.deviceId) {
      const count = (this.perDevice.get(stream.deviceId) ?? 0) + 1;
      this.perDevice.set(stream.deviceId, count);
      if (count === 1) this.ctx.events.publish(stream.userId, "devices");
    }
    this.timer ??= setInterval(() => this.beat(), this.beatMs).unref();
  }

  /** With a reason, a member stream is told why before it closes, so its tab can end the session. */
  end(stream: Stream, reason?: EndReason) {
    if (!this.open.delete(stream)) return;
    stream.unsubscribe();
    if (reason && stream.deviceId) {
      const event: SessionEnded = { reason };
      stream.res.write(`event: ended\ndata: ${JSON.stringify(event)}\n\n`);
    }
    stream.res.end();
    if (stream.deviceId) {
      const count = (this.perDevice.get(stream.deviceId) ?? 1) - 1;
      if (count > 0) this.perDevice.set(stream.deviceId, count);
      else {
        this.perDevice.delete(stream.deviceId);
        this.ctx.events.publish(stream.userId, "devices");
      }
    }
    if (!this.open.size) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Ends streams whose session or grant is gone. Called right after sessions are revoked, with a
   * hint when the reason is not visible in the database (a password reset rather than a sign-out).
   */
  recheck(hint?: EndHint) {
    for (const stream of [...this.open]) {
      const reason = stream.ended(hint?.userId === stream.userId ? hint : undefined);
      if (reason) this.end(stream, reason);
    }
  }

  private beat() {
    for (const stream of [...this.open]) {
      const reason = stream.ended(undefined);
      if (reason) {
        this.end(stream, reason);
        continue;
      }
      // An event rather than a comment, so the page can tell a quiet stream from a cut one.
      stream.res.write("event: beat\ndata: {}\n\n");
      stream.renew();
    }
  }

  closeAll() {
    for (const stream of [...this.open]) this.end(stream);
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

function openStream(ctx: Context, reply: FastifyReply, spec: Omit<Stream, "res" | "unsubscribe">, subscribe: boolean) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  const streams = streamsOf(ctx);
  const ready: StreamReady = { beatMs: streams.beatMs };
  res.write(`event: ready\ndata: ${JSON.stringify(ready)}\n\n`);
  const unsubscribe = subscribe
    ? ctx.events.subscribe(spec.userId, (topics) => {
        const event: ChangeEvent = { topics };
        res.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
      })
    : () => {};
  const stream: Stream = { ...spec, res, unsubscribe };
  res.on("close", () => streams.end(stream));
  streams.add(stream);
}

function memberStream(ctx: Context, req: FastifyRequest, reply: FastifyReply) {
  const member: Member = requireMember(ctx, req);
  const token = req.cookies[sessionCookie(ctx, req)];
  const tab = tabOf(req);
  const renew = () => {
    if (tab) ctx.transfers.renewTab(tab, member);
    ctx.db.run("UPDATE devices SET seen = ? WHERE id = ?", Date.now(), member.deviceId);
  };
  const expiresAt = () => ctx.db.value<number>("SELECT expires FROM sessions WHERE token_hash = ?", member.sessionHash);
  // Remembered so a session that expired and was then swept still reads as expired.
  const opened = expiresAt()!;
  const ended = (hint: EndHint | undefined): EndReason | null => {
    if (memberFromToken(ctx, token)?.sessionHash === member.sessionHash) return null;
    if (ctx.db.value("SELECT disabled FROM users WHERE id = ?", member.userId)) return "suspended";
    if (Date.now() >= (expiresAt() ?? opened)) return "expired";
    return hint?.reason ?? "signed-out";
  };
  renew();
  openStream(
    ctx,
    reply,
    {
      userId: member.userId,
      deviceId: member.deviceId,
      capKey: `session:${member.sessionHash}`,
      cap: 8,
      ended,
      renew,
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
  const renew = () => {
    if (tab) ctx.transfers.renewTab(tab, grant);
  };
  renew();
  const ended = (): EndReason | null => {
    const now = Date.now();
    const valid = !!ctx.db.get(
      `SELECT 1 FROM guest_grants g JOIN requests r ON r.id = g.request_id JOIN users u ON u.id = r.owner
       WHERE g.token_hash = ? AND g.expires > ? AND r.closed IS NULL AND r.expires > ? AND u.disabled = 0`,
      grant.tokenHash,
      now,
      now,
    );
    // Guest pages learn nothing from the reason; their stream just closes.
    return valid ? null : "expired";
  };
  openStream(
    ctx,
    reply,
    { userId: grant.owner, deviceId: null, capKey: `grant:${grant.tokenHash}`, cap: 4, ended, renew },
    false,
  );
}

export function registerStreams(app: FastifyInstance, ctx: Context) {
  app.get("/api/events", (req, reply) => memberStream(ctx, req, reply));
  app.get<{ Params: { token: string } }>("/api/r/:token/events", (req, reply) => guestStream(ctx, req, reply));
  app.addHook("preClose", () => streamsOf(ctx).closeAll());
}
