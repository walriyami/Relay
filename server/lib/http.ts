import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Auth as AuthKind, Body, Endpoint, Params, Query, Response, Schema } from "../../shared/api.ts";
import type { Auth, Context, Member } from "../context.ts";
import { authOf, requireAdmin, requireMember } from "./auth.ts";

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
  /** Overrides the 1 MiB JSON body limit, e.g. for transfer manifests. */
  bodyLimit?: number;
};

/**
 * Registers a contract endpoint. Auth is enforced from the definition before the handler runs;
 * query and body are parsed with the definition's schemas. CSRF is enforced by the global hook
 * from `config.csrf`.
 */
export function route<E extends Endpoint>(
  app: FastifyInstance,
  ctx: Context,
  endpoint: E,
  handler: Handler<E>,
  options: RouteOptions = {},
) {
  app.route({
    method: endpoint.method,
    url: endpoint.path,
    ...(options.bodyLimit ? { bodyLimit: options.bodyLimit } : {}),
    config: {
      csrf: endpoint.csrf,
      auth: endpoint.auth,
      ...(options.rateLimit ? { rateLimit: { ...options.rateLimit, allowList: [] as string[] } } : {}),
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

function authorize(ctx: Context, req: FastifyRequest, auth: AuthKind): Member | null {
  switch (auth) {
    case "member":
      return requireMember(ctx, req);
    case "admin":
      return requireAdmin(ctx, req);
    case "any":
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
