import type { FastifyReply, FastifyRequest } from "fastify";
import type { Auth as AuthKind } from "../../shared/api.ts";
import type { Auth, Context, Grant, Member } from "../context.ts";
import { fail } from "./errors.ts";
import { sha256 } from "./secrets.ts";

/**
 * Relay answers on whatever address it is opened at, so nobody has to tell it its own address.
 * RELAY_ORIGIN pins one instead. Otherwise the scheme is the one the connection (or a trusted
 * proxy's X-Forwarded-Proto) reports, and the host is the one the browser addressed.
 */
const secure = (ctx: Context, req: FastifyRequest) =>
  ctx.config.origin ? ctx.config.origin.startsWith("https:") : req.protocol === "https";

/**
 * The origin this request was made to. On unsafe requests that is the browser's Origin header,
 * which `checkCsrf` has already matched to this server.
 */
export function requestOrigin(ctx: Context, req: FastifyRequest) {
  if (ctx.config.origin) return ctx.config.origin;
  const origin = req.headers.origin;
  return origin && sameHost(origin, req) ? origin : `${req.protocol}://${req.host}`;
}

/**
 * An Origin naming the host this request was sent to. Only the host is compared: a proxy that
 * doesn't report https still serves the right site, and another site always has another host.
 */
function sameHost(origin: string, req: FastifyRequest) {
  try {
    return new URL(origin).host === req.host.toLowerCase();
  } catch {
    return false;
  }
}

// On https the __Host- prefix stops sibling subdomains from planting or shadowing these cookies.
const cookiePrefix = (ctx: Context, req: FastifyRequest) => (secure(ctx, req) ? "__Host-" : "");
export const sessionCookie = (ctx: Context, req: FastifyRequest) => `${cookiePrefix(ctx, req)}relay`;
const guestCookiePrefix = (ctx: Context, req: FastifyRequest) => `${cookiePrefix(ctx, req)}relay_guest_`;
export const guestCookie = (ctx: Context, req: FastifyRequest, requestId: string) =>
  guestCookiePrefix(ctx, req) + requestId;
/** Tells one person opening shared links from another; it grants nothing by itself. */
export const visitorCookie = (ctx: Context, req: FastifyRequest) => `${cookiePrefix(ctx, req)}relay_visitor`;

const cache = new WeakMap<FastifyRequest, Auth>();

type MemberRow = {
  token_hash: string;
  user_id: string;
  device_id: string;
  csrf: string;
  username: string;
  admin: number;
  quota: number;
  retention_days: number | null;
};

/** Looks up a session token. Used by requests and by long-lived streams that re-check it. */
export function memberFromToken(ctx: Context, token: string | undefined): Member | null {
  if (!token) return null;
  const row = ctx.db.get<MemberRow>(
    `SELECT s.token_hash, s.user_id, s.device_id, s.csrf, u.username, u.admin, u.quota, u.retention_days
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires > ? AND u.disabled = 0`,
    sha256(token),
    Date.now(),
  );
  return row
    ? {
        kind: "member",
        userId: row.user_id,
        username: row.username,
        admin: !!row.admin,
        quota: row.quota,
        retentionDays: row.retention_days,
        sessionHash: row.token_hash,
        deviceId: row.device_id,
        csrf: row.csrf,
      }
    : null;
}

type GrantRow = {
  token_hash: string;
  request_id: string;
  owner: string;
  item: string | null;
  csrf: string;
  expires: number;
};

/** A guest grant is usable only while its request is open and its owner is active. */
function grantFromToken(ctx: Context, requestId: string, token: string): Grant | null {
  const now = Date.now();
  const row = ctx.db.get<GrantRow>(
    `SELECT g.token_hash, g.request_id, r.owner, g.item, g.csrf, g.expires
     FROM guest_grants g JOIN requests r ON r.id = g.request_id JOIN users u ON u.id = r.owner
     WHERE g.token_hash = ? AND g.request_id = ? AND g.expires > ?
       AND r.closed IS NULL AND r.expires > ? AND u.disabled = 0`,
    sha256(token),
    requestId,
    now,
    now,
  );
  return row
    ? {
        kind: "grant",
        tokenHash: row.token_hash,
        requestId: row.request_id,
        owner: row.owner,
        itemId: row.item,
        csrf: row.csrf,
        expires: row.expires,
      }
    : null;
}

/** Everything the request's cookies authenticate. Computed once per request. */
export function authOf(ctx: Context, req: FastifyRequest): Auth {
  let auth = cache.get(req);
  if (auth) return auth;
  const grants: Grant[] = [];
  const prefix = guestCookiePrefix(ctx, req);
  for (const [name, value] of Object.entries(req.cookies)) {
    if (!value || !name.startsWith(prefix)) continue;
    const grant = grantFromToken(ctx, name.slice(prefix.length), value);
    if (grant) grants.push(grant);
  }
  auth = { member: memberFromToken(ctx, req.cookies[sessionCookie(ctx, req)]), grants };
  cache.set(req, auth);
  return auth;
}

export function requireMember(ctx: Context, req: FastifyRequest): Member {
  return authOf(ctx, req).member ?? fail(401, "Sign in to continue.");
}
export function requireAdmin(ctx: Context, req: FastifyRequest): Member {
  const member = requireMember(ctx, req);
  if (!member.admin) fail(403, "Administrator access required.");
  return member;
}
export function grantFor(ctx: Context, req: FastifyRequest, requestId: string): Grant | null {
  return authOf(ctx, req).grants.find((g) => g.requestId === requestId) ?? null;
}
/** The principal that owns a tab or transfer, if this request authenticates as it. */
export function principalFor(ctx: Context, req: FastifyRequest, key: string): Member | Grant | null {
  const auth = authOf(ctx, req);
  if (auth.member && key === `user:${auth.member.userId}`) return auth.member;
  return auth.grants.find((g) => key === `grant:${g.tokenHash}`) ?? null;
}

/**
 * Cross-site request protection for unsafe methods: the Origin must be ours (RELAY_ORIGIN when
 * set, else this request's own host; see `requestOrigin`), Fetch Metadata must
 * not say cross-site, and, unless the route opts out, X-Relay-CSRF must match the token of the
 * credential the route acts on: the session's for member and admin routes, the session's or a
 * guest grant's for routes open to both.
 */
export function checkCsrf(ctx: Context, req: FastifyRequest, route: { csrf?: boolean; auth?: AuthKind }) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const origin = req.headers.origin;
  if (origin && (ctx.config.origin ? origin !== ctx.config.origin : !sameHost(origin, req)))
    fail(403, "Cross-origin requests are not allowed.");
  if (req.headers["sec-fetch-site"] === "cross-site") fail(403, "Cross-site requests are not allowed.");
  if (route.csrf === false) return;
  const auth = authOf(ctx, req);
  // CSRF protects ambient credentials; a request carrying none is left to the route's auth check.
  if (!auth.member && !auth.grants.length) return;
  const token = req.headers["x-relay-csrf"];
  const memberOnly = route.auth === "member" || route.auth === "admin";
  const valid =
    typeof token === "string" &&
    (token === auth.member?.csrf || (!memberOnly && auth.grants.some((g) => g.csrf === token)));
  if (!valid) fail(403, "Your session has changed. Refresh and retry.");
}

export function cookieOptions(ctx: Context, req: FastifyRequest, maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secure(ctx, req),
    path: "/",
    maxAge: Math.max(1, Math.floor(maxAgeMs / 1000)),
  };
}
export function clearCookie(ctx: Context, reply: FastifyReply, name: string) {
  reply.clearCookie(name, { ...cookieOptions(ctx, reply.request, 1), maxAge: undefined });
}
