import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { api, type Endpoint } from "../../shared/api.ts";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/**
 * Responses that grow with what a person keeps: collection metadata, and the lists of links,
 * requests, deliveries and activity. Nothing else is compressed, so the session response and its
 * CSRF token never are.
 */
export const compressed = new Set<Endpoint>([
  api.items.list,
  api.items.get,
  api.links.list,
  api.links.open,
  api.links.unlock,
  api.requests.list,
  api.requests.submissions,
  api.deliveries.list,
  api.activity.list,
]);

/** Below this, headers and framing cost more than compression saves. */
const MIN_BYTES = 1024;

/** The best encoding the client accepts, honouring `q=0` refusals. */
export function encodingFor(accept: string | undefined): "br" | "gzip" | null {
  if (!accept) return null;
  const weights = new Map<string, number>();
  for (const part of accept.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    weights.set(name.trim(), q ? Number(q.slice(2)) || 0 : 1);
  }
  const accepts = (name: string) => (weights.get(name) ?? weights.get("*") ?? 0) > 0;
  return accepts("br") ? "br" : accepts("gzip") ? "gzip" : null;
}

/**
 * Compresses large JSON from the `compressed` endpoints: collection metadata grows with the number
 * of files, and its names repeat enough to shrink tenfold or more.
 *
 * Only requests the app's own pages make are compressed. Compressed length leaks how much a response
 * repeats itself (BREACH), and these responses can hold both secrets, such as link tokens, and names
 * another person chose. A browser marks a request another site causes, even a top-level navigation,
 * as not same-origin, so no other site can have the browser fetch a compressed copy to measure.
 */
export function registerCompression(app: FastifyInstance) {
  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.routeOptions.config?.compress || reply.statusCode !== 200) return payload;
    reply.header("Vary", "Accept-Encoding, Sec-Fetch-Site");
    if (typeof payload !== "string" || req.method === "HEAD") return payload;
    const bytes = Buffer.byteLength(payload);
    if (bytes < MIN_BYTES || !sameOrigin(req) || reply.hasHeader("content-encoding")) return payload;
    const encoding = encodingFor(req.headers["accept-encoding"]);
    if (!encoding) return payload;
    const body =
      encoding === "br"
        ? // Quality 4 compresses metadata nearly as well as the default at a fraction of the CPU.
          await brotli(payload, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: 4,
              [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
              [constants.BROTLI_PARAM_SIZE_HINT]: bytes,
            },
          })
        : await gzipped(payload);
    reply.header("Content-Encoding", encoding);
    reply.removeHeader("content-length");
    return body;
  });
}

function sameOrigin(req: FastifyRequest) {
  return req.headers["sec-fetch-site"] === "same-origin";
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Compress large JSON responses for the app's own requests. */
    compress?: boolean;
  }
}
