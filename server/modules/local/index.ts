// Direct transfers on the local network (see shared/local.ts). Relay sets up a browser's connection
// with the relay-local helper, and serves the requests the helper forwards on a socket of its own:
// only the bulk routes, each as the session whose local token it carries.
import type { FastifyInstance } from "fastify";
import { mkdir, chmod, rm } from "node:fs/promises";
import { createServer, request, type ServerResponse } from "node:http";
import { join } from "node:path";
import { api } from "../../../shared/api.ts";
import { isLocalRoute, LOCAL_TOKEN_HEADER, SOCKETS, type HelperStatus } from "../../../shared/local.ts";
import type { LocalStatus } from "../../../shared/model.ts";
import type { Context } from "../../context.ts";
import { currentMember, isLocal, markLocal } from "../../lib/auth.ts";
import { fail, HttpError, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { addressKey } from "../auth/limits.ts";

const UNAVAILABLE = "Direct transfers are unavailable right now.";

export function registerLocal(app: FastifyInstance, ctx: Context) {
  route(
    app,
    ctx,
    api.local.connect,
    async ({ member, body }) => {
      const dir = ctx.config.local ?? fail(404, "Direct transfers are not set up on this server.");
      const token = ctx.secrets.localToken(member.sessionHash);
      const { answer } = await askHelper<{ answer: string }>(dir, "POST", "/connect", { offer: body.offer, token });
      return { answer };
    },
    {
      // A page connects once, and again after losing the connection, at most every 15 seconds.
      rateLimit: {
        max: 30,
        timeWindow: "1 minute",
        keyGenerator: (req) => `local:${currentMember(ctx, req)?.userId ?? addressKey(req.ip)}`,
      },
    },
  );
  route(app, ctx, api.local.check, ({ req }) => (isLocal(req) ? { ok: true as const } : notFound()));

  if (ctx.config.local) serveSocket(app, ctx, ctx.config.local);
}

/** Whether browsers can connect, for the administrator. */
export async function localStatus(ctx: Context): Promise<LocalStatus> {
  if (!ctx.config.local) return { state: "off" };
  try {
    return { state: "ready", ...(await askHelper<HelperStatus>(ctx.config.local, "GET", "/status")) };
  } catch {
    return { state: "down" };
  }
}

/**
 * Serves the requests the helper forwards. The socket lives in the directory Relay shares with the
 * helper alone, and each request must carry a local token (see Secrets.localToken); anything but
 * the bulk routes is refused before it reaches the app.
 */
function serveSocket(app: FastifyInstance, ctx: Context, dir: string) {
  const path = join(dir, SOCKETS.relay);
  // The same limits as the app's own server (see app.ts).
  const server = createServer({ requestTimeout: 120_000 }, (req, res) => {
    const session = ctx.secrets.localSession(req.headers[LOCAL_TOKEN_HEADER]);
    delete req.headers[LOCAL_TOKEN_HEADER];
    // 421: the browser should stop using its connection and send the request the usual way.
    if (!session) return refuse(res, 421, "This connection was set up with another server key.");
    if (!isLocalRoute(req.method ?? "", req.url ?? "")) return refuse(res, 404, "Not found.");
    markLocal(req, session);
    app.routing(req, res);
  });
  server.setTimeout(120_000);
  app.addHook("onReady", async () => {
    await mkdir(dir, { recursive: true });
    // A socket left by a Relay that did not shut down would refuse the new one.
    await rm(path, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
  });
  // Stop taking requests with the app's own server, and let those under way finish.
  app.addHook("preClose", async () => {
    if (!server.listening) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    await closed;
  });
}

function refuse(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error }));
}

/** A request to the helper's socket. Any failure is the helper being unavailable, except a refused offer. */
function askHelper<T>(dir: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        socketPath: join(dir, SOCKETS.helper),
        method,
        path,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) req.destroy(new Error("The helper's answer is too large."));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode === 400) return reject(new HttpError(400, "The connection offer was not valid."));
          if (res.statusCode !== 200) return reject(new HttpError(503, UNAVAILABLE));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch {
            reject(new HttpError(503, UNAVAILABLE));
          }
        });
        res.on("error", () => reject(new HttpError(503, UNAVAILABLE)));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => reject(new HttpError(503, UNAVAILABLE)));
    req.end(payload);
  });
}
