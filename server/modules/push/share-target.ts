// "Share to Relay" posts what was shared to /share (public/manifest.webmanifest). Relay's service
// worker (public/sw.js) takes it in the browser and keeps it there; the server never stores it. This
// route only answers when the worker didn't (it was removed, or is still installing): it reads and
// discards the upload and sends the browser to Send, which says to share again.
import type { FastifyInstance } from "fastify";

export const SHARE_FAILED = "/share?id=failed";

export function registerShareTarget(app: FastifyInstance) {
  void app.register((scope, _options, done) => {
    // Anything the share sheet sends is drained unread instead of being parsed or rejected.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, parsed) => {
      payload.resume();
      parsed(null);
    });
    scope.post("/share", { config: { csrf: false } }, (_req, reply) =>
      reply.header("Connection", "close").redirect(SHARE_FAILED, 303),
    );
    done();
  });
}
