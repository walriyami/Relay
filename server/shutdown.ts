import type { FastifyInstance } from "fastify";

/** How long requests still running at shutdown get to finish before their connections are cut. */
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Stops Relay for a restart or update. It stops taking new requests, and requests still running get a
 * few seconds to finish. Then their connections are cut, so one slow download can't keep the site down
 * until the request timeout. Nothing is lost: downloads continue with Range requests, uploads
 * continue from their committed offset, and event streams reconnect.
 */
export async function shutdown(app: FastifyInstance, graceMs = SHUTDOWN_GRACE_MS) {
  const cut = setTimeout(() => app.server.closeAllConnections(), graceMs);
  try {
    await app.close();
  } finally {
    clearTimeout(cut);
  }
}
