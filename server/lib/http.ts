import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Auth as AuthKind, Body, Endpoint, Params, Query, Response, Schema } from "../../shared/api.ts";
import type { Auth, Context, Member } from "../context.ts";
import { authOf, requireAdmin, requireMember } from "./auth.ts";
import { fail } from "./errors.ts";
import { compressed } from "./compress.ts";
import { sha256 } from "./secrets.ts";
import { wideNetworkOf } from "../modules/auth/limits.ts";

export type Handler<E extends Endpoint> = (call: {
  req: FastifyRequest;
  reply: FastifyReply;
  params: Params<E>;
  query: Query<E>;
  body: Body<E>;
  /** Present for member and admin endpoints; possibly null otherwise. */
  member: E extends Endpoint<string, Schema, Schema, unknown, "member" | "admin"> ? Member : Member | null;
  auth: Auth;
}) => Response<E> | Promise<Response<E>>;

export type RouteOptions = {
  /** `keyGenerator` picks the bucket; the plugin defaults to the client IP. */
  rateLimit?: { max: number; timeWindow: string; keyGenerator?: (req: FastifyRequest) => string };
  /** Overrides the 1 MiB JSON body limit, e.g. for transfer manifests. Needs a credential (see `admit`). */
  bodyLimit?: number;
  /**
   * Checks the caller before the body is read, in place of the route's auth kind (which the handler
   * still applies): it throws to refuse. For a route whose credential depends on its address, such
   * as a request link's grant.
   */
  admit?: (req: FastifyRequest) => void;
};

/**
 * Registers a contract endpoint. Auth is enforced from the definition before the body is read, so a
 * stranger can't make Relay receive and parse one; query and body are parsed with the definition's
 * schemas. CSRF is enforced by the global hook from `config.csrf`.
 */
export function route<E extends Endpoint>(
  app: FastifyInstance,
  ctx: Context,
  endpoint: E,
  handler: Handler<E>,
  options: RouteOptions = {},
) {
  // Only a caller who already holds a credential may send more than the default.
  if (options.bodyLimit && endpoint.auth === "public" && !options.admit)
    throw new Error(`${endpoint.method} ${endpoint.path} raises the body limit for anyone.`);
  app.route({
    method: endpoint.method,
    url: endpoint.path,
    ...(options.bodyLimit ? { bodyLimit: options.bodyLimit } : {}),
    // After every onRequest hook (host, CSRF, shared sign-in, rate limit), and before the body is read.
    preParsing: (req, reply, payload, done) => {
      try {
        // A route's own check names what is wrong more precisely, such as a closed request.
        if (options.admit) options.admit(req);
        else authorize(ctx, req, endpoint.auth, true);
        if (options.bodyLimit) holdLargeBody(ctx, req, reply);
        done(null, payload);
      } catch (error) {
        done(error as Error);
      }
    },
    config: {
      csrf: endpoint.csrf,
      auth: endpoint.auth,
      ...(options.rateLimit ? { rateLimit: { ...options.rateLimit, allowList: [] as string[] } } : {}),
      ...(compressed.has(endpoint) ? { compress: true } : {}),
    },
    handler: async (req, reply) => {
      const member = authorize(ctx, req, endpoint.auth);
      const query = (endpoint.query ? endpoint.query.parse(req.query ?? {}) : undefined) as Query<E>;
      const body = (endpoint.body ? endpoint.body.parse(req.body ?? {}) : undefined) as Body<E>;
      return handler({
        req,
        reply,
        params: req.params as Params<E>,
        query,
        body,
        member: member as never,
        auth: authOf(ctx, req),
      });
    },
  });
}

/** Fastify's body limit for every route that doesn't raise it. */
export const DEFAULT_BODY_BYTES = 1024 * 1024;
/**
 * Larger bodies that callers without a session may have Relay read and parse at once. Parsing one
 * near the 32 MiB limit takes several times that in memory, and anyone who opens a request link
 * gets a grant; members are trusted, like everywhere else. One request link, and one network (an
 * IPv4 /24 or IPv6 /48), may hold only some of the places, so a single visitor can't take them all
 * and turn everyone else away.
 */
export const MAX_LARGE_GUEST_BODIES = 4;
export const MAX_LARGE_GUEST_BODIES_EACH = 2;
const largeGuestBodies = new WeakMap<Context, Map<string, number>>();

/** Takes one of the guests' large-body places until the reply is sent, or refuses when none is free. */
function holdLargeBody(ctx: Context, req: FastifyRequest, reply: FastifyReply) {
  const declared = Number(req.headers["content-length"] ?? Infinity);
  if (declared <= DEFAULT_BODY_BYTES || authOf(ctx, req).member) return;
  let held = largeGuestBodies.get(ctx);
  if (!held) largeGuestBodies.set(ctx, (held = new Map<string, number>()));
  const token = (req.params as { token?: unknown } | undefined)?.token;
  const keys = [
    "all",
    `network:${wideNetworkOf(req.ip)}`,
    ...(typeof token === "string" ? [`link:${sha256(token)}`] : []),
  ];
  const full = (key: string) =>
    (held.get(key) ?? 0) >= (key === "all" ? MAX_LARGE_GUEST_BODIES : MAX_LARGE_GUEST_BODIES_EACH);
  if (keys.some(full)) {
    reply.header("Retry-After", "5");
    fail(503, "Relay is busy receiving other uploads. Try again in a moment.");
  }
  for (const key of keys) held.set(key, (held.get(key) ?? 0) + 1);
  // Sent, failed or cut off, the reply closes once.
  reply.raw.once("close", () => {
    for (const key of keys) {
      const left = (held.get(key) ?? 1) - 1;
      if (left > 0) held.set(key, left);
      else held.delete(key);
    }
  });
}

/**
 * The member a route acts for, refusing a caller its auth kind doesn't admit. `early` also refuses
 * an "any" route's caller with neither a session nor a guest grant, before the body is read; the
 * handler then decides which of them owns the target.
 */
function authorize(ctx: Context, req: FastifyRequest, auth: AuthKind, early = false): Member | null {
  switch (auth) {
    case "member":
      return requireMember(ctx, req);
    case "admin":
      return requireAdmin(ctx, req);
    case "any": {
      const auth = authOf(ctx, req);
      if (early && !auth.member && !auth.grants.length)
        fail(401, "Sign in, or open the request link again, to continue.");
      return auth.member;
    }
    case "public":
      return authOf(ctx, req).member;
  }
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** False for sign-in style endpoints that cannot hold a CSRF token yet. Defaults to true. */
    csrf?: boolean;
    /** The contract's auth kind; routes without one (tus) accept member or guest tokens. */
    auth?: AuthKind;
  }
}
