import Fastify, { LogController, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { core as zod } from "zod/mini";
import type { Config } from "./config.ts";
import type { Context } from "./context.ts";
import { Database } from "./db/database.ts";
import { EventBus } from "./lib/events.ts";
import { HttpError } from "./lib/errors.ts";
import { Secrets } from "./lib/secrets.ts";
import { checkHost, checkCsrf, currentMember, isLocal } from "./lib/auth.ts";
import { route } from "./lib/http.ts";
import { api, headers } from "../shared/api.ts";
import { createBlobStore } from "./storage/blobs.ts";
import { createLibrary, registerLibrary } from "./modules/library/index.ts";
import { createTransfers, registerTransfers } from "./modules/transfers/index.ts";
import { registerDownloads } from "./modules/downloads/index.ts";
import { addressKey } from "./modules/auth/limits.ts";
import { registerAuth, sweepAuth } from "./modules/auth/index.ts";
import { createLinks, registerLinks } from "./modules/links/index.ts";
import { registerCodes } from "./modules/codes/index.ts";
import { createDeliveries, registerDeliveries } from "./modules/deliveries/index.ts";
import { registerRequests } from "./modules/requests/index.ts";
import { registerAdmin } from "./modules/admin/index.ts";
import { registerSetup } from "./modules/setup/index.ts";
import { createActivity, registerActivity } from "./modules/activity/index.ts";
import { createUsageMeter, registerUsage } from "./modules/usage/index.ts";
import { issueRecovery, registerRecovery } from "./modules/recovery/index.ts";
import { registerAccountData } from "./modules/account-data/index.ts";
import { recordHistory, registerHistory, sweepHistory } from "./modules/history/index.ts";
import { LocalHelper } from "./modules/local/helper.ts";
import { registerLocal } from "./modules/local/index.ts";
import { registerNearby } from "./modules/nearby/index.ts";
import { Operations } from "./lib/operations.ts";
import { registerCompression } from "./lib/compress.ts";
import { createHealth } from "./health-status.ts";
import { ProxyTrust } from "./lib/proxies.ts";
import { registerSharedSignIn } from "./modules/auth/sso.ts";
import { createPush, registerPush } from "./modules/push/index.ts";
import { registerShareTarget } from "./modules/push/share-target.ts";

export type App = { app: FastifyInstance; ctx: Context; sweep: () => Promise<void> };

export async function buildApp(config: Config): Promise<App> {
  for (const dir of ["", "blobs", "uploads", "thumbnails"]) {
    const path = join(config.root, dir);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    // mkdir's mode is ignored for existing volumes, including data from older installations.
    chmodSync(path, 0o700);
  }
  // Before the database: a mistyped entry stops startup without holding its lock.
  const proxies = new ProxyTrust(config.trustProxy);
  const db = new Database(join(config.root, "relay.sqlite"));
  const app = Fastify({
    logger: config.logger ? { level: "info", redact: ["req.headers.cookie", "req.headers['x-relay-csrf']"] } : false,
    // Fastify's own request lines include raw URLs; the onResponse hook below logs routes instead.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    // Receiving a request, body included, may take two minutes. Browsers size upload chunks to take
    // about 15 seconds at the rate they are getting, shrinking them when a request is cut short, so
    // only a stalled or trickling request reaches it. Idle sockets close too; active downloads and
    // the event stream's heartbeats never idle.
    requestTimeout: 120_000,
    connectionTimeout: 120_000,
    trustProxy: proxies.trusts,
  });

  try {
    // Services reference each other through ctx, so construction order does not matter.
    const ctx = {
      config,
      db,
      operations: new Operations(config.sweepMs),
      secrets: new Secrets(config.root, config.secret),
      events: new EventBus(),
      local: config.local ? new LocalHelper(config.local.port, app.log, config.local.addresses) : null,
      log: app.log,
    } as Context;
    ctx.blobs = createBlobStore(ctx);
    ctx.library = createLibrary(ctx);
    ctx.transfers = createTransfers(ctx);
    ctx.links = createLinks(ctx);
    ctx.deliveries = createDeliveries(ctx);
    ctx.activity = createActivity(ctx);
    ctx.push = createPush(ctx);
    ctx.usage = createUsageMeter(ctx);

    let sweeping: Promise<void> | null = null;
    let timer: NodeJS.Timeout | null = null;
    app.addHook("preClose", async () => {
      if (timer) clearInterval(timer);
      await sweeping;
      try {
        await ctx.blobs.close();
      } finally {
        ctx.events.close();
      }
    });
    app.addHook("onClose", () =>
      Promise.resolve().then(() => {
        proxies.stop();
        // Counts from the last few seconds, including the requests that just finished.
        try {
          ctx.usage.close();
        } finally {
          db.close();
        }
      }),
    );

    await proxies.start(app.log);
    const header = config.clientIpHeader;
    app.addHook("onRequest", (req, _reply, done) => {
      // The Host header is what the proxy routed by. X-Forwarded-Host may be the visitor's own,
      // passed along by a proxy that forwards headers as they came.
      delete req.headers["x-forwarded-host"];
      // A trusted proxy names the visitor in its own header (Cloudflare's CF-Connecting-IP). Before
      // the rate limiter runs, it becomes the forwarded address, so req.ip is the visitor everywhere.
      // Without a valid one, the request counts as the proxy's: X-Forwarded-For may be the visitor's
      // own choice, passed along.
      if (header && proxies.trusts(req.socket.remoteAddress)) {
        const reported = req.headers[header];
        if (typeof reported === "string" && isIP(reported.trim())) req.headers["x-forwarded-for"] = reported.trim();
        else delete req.headers["x-forwarded-for"];
      } else if (
        req.headers[header ?? "x-forwarded-for"] !== undefined &&
        proxies.awaitingProxy(req.socket.remoteAddress)
      )
        // A proxy listed by name that Relay hasn't found yet: wait rather than count every visitor as one.
        return done(new HttpError(503, "Relay is starting up. Try again in a few seconds."));
      done();
    });
    await app.register(cookie);
    await app.register(rateLimit, {
      max: 6000,
      timeWindow: "1 minute",
      // One bucket per IPv4 address or IPv6 /64, so an IPv6 host cannot rotate addresses. Requests
      // through the local helper have no address, and each carries a member's session.
      keyGenerator: (req) => (isLocal(req) ? "local" : addressKey(req.ip)),
      // Signed-in members are trusted; the limit protects anonymous surfaces.
      allowList: (req) => !!currentMember(ctx, req),
      // Visitors don't need a running count of their budget; only a refusal says when to come back.
      addHeadersOnExceeding: { "x-ratelimit-limit": false, "x-ratelimit-remaining": false, "x-ratelimit-reset": false },
      addHeaders: {
        "x-ratelimit-limit": false,
        "x-ratelimit-remaining": false,
        "x-ratelimit-reset": false,
        "retry-after": true,
      },
    });

    app.addHook("onRequest", async (req, reply) => {
      proxies.checkForwarded(req.socket.remoteAddress, req.headers["x-forwarded-for"]);
      reply
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header("X-Frame-Options", "DENY")
        // Another site's window can't keep a handle on Relay's, and nothing here may use the camera,
        // microphone, location or payment devices.
        .header("Cross-Origin-Opener-Policy", "same-origin")
        .header(
          "Permissions-Policy",
          "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
        )
        .header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        );
      if (config.origin?.startsWith("https:")) reply.header("Strict-Transport-Security", "max-age=31536000");
      // Stamped before the handler reads anything, so a view can tell what it may have missed.
      if (req.url.startsWith("/api/"))
        reply.header("Cache-Control", "no-store").header(headers.changes, ctx.events.stamp());
      checkHost(ctx, req);
      checkCsrf(ctx, req, req.routeOptions.config ?? {});
    });
    registerCompression(app);
    // Log the route pattern, never the raw URL: link and request tokens travel in paths.
    app.addHook("onResponse", async (req, reply) => {
      if (!req.routeOptions.url || req.routeOptions.url === "/api/health") return;
      ctx.operations.response(reply.statusCode);
      ctx.usage.request(reply.statusCode >= 500);
      req.log.info(
        {
          method: req.method,
          route: req.routeOptions.url,
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
          ...(isLocal(req) ? { local: true } : {}),
        },
        "request",
      );
    });
    app.setErrorHandler((error, req, reply) => {
      if (error instanceof zod.$ZodError) return reply.code(400).send({ error: "Please check the supplied fields." });
      if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 429) {
        // The limiter's own wording ("Rate limit exceeded, retry in 16 seconds") is not for people.
        const wait = Math.max(1, Math.ceil(Number(reply.getHeader("retry-after")) || 60));
        return reply
          .code(429)
          .send({ error: `Too many tries. Wait ${wait === 1 ? "a second" : `${wait} seconds`} and try again.` });
      }
      if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
      if (isOutOfSpace(error)) {
        req.log.warn({ route: req.routeOptions.url }, "storage is full");
        recordHistory(
          ctx,
          { kind: "error", area: areaOf(req.routeOptions.url), detail: "The server’s disk was full." },
          null,
          "disk-full",
        );
        return reply.code(507).send({ error: "The server's disk is full. Retry after space is freed." });
      }
      req.log.error({ err: error, route: req.routeOptions.url }, "request failed");
      recordHistory(
        ctx,
        {
          kind: "error",
          area: areaOf(req.routeOptions.url),
          detail: "Something unexpected went wrong; the server log has the details.",
        },
        null,
        `error:${req.routeOptions.url ?? ""}`,
      );
      return reply.code(500).send({ error: "The operation could not finish. Retry or contact the administrator." });
    });

    const health = createHealth(ctx);
    route(app, ctx, api.health, async ({ reply }) => {
      const result = await health();
      // Only what a restart may fix fails the check; everything else reports degraded with a 200.
      if (!result.ok) reply.code(503);
      return result;
    });
    registerAuth(app, ctx);
    await registerSharedSignIn(app, ctx);
    registerLibrary(app, ctx);
    registerTransfers(app, ctx);
    registerDownloads(app, ctx);
    registerLinks(app, ctx);
    registerCodes(app, ctx);
    registerDeliveries(app, ctx);
    registerRequests(app, ctx);
    registerAdmin(app, ctx);
    registerSetup(app, ctx);
    registerActivity(app, ctx);
    registerPush(app, ctx);
    registerShareTarget(app);
    registerUsage(app, ctx);
    registerRecovery(app, ctx);
    registerAccountData(app, ctx);
    registerHistory(app, ctx);
    registerLocal(app, ctx);
    registerNearby(app, ctx);

    const sweep = () =>
      (sweeping ??= (async () => {
        const now = Date.now();
        const stages: [string, () => unknown][] = [
          ["Library retention", () => ctx.library.sweep(now)],
          ["Upload cleanup", () => ctx.transfers.sweep(now)],
          [
            "Blob cleanup",
            async () => {
              try {
                await ctx.blobs.drain();
              } finally {
                ctx.blobs.sweep();
              }
            },
          ],
          ["Session cleanup", () => sweepAuth(ctx, now)],
          ["Activity cleanup", () => ctx.activity.sweep(now)],
          ["Usage statistics", () => ctx.usage.sweep(now)],
          ["History cleanup", () => sweepHistory(ctx, now)],
        ];
        // One failed job must not prevent unrelated cleanup from running.
        for (const [name, work] of stages)
          await ctx.operations.run(name, work, (error) => {
            app.log.error({ err: error, stage: name }, "maintenance failed");
            recordHistory(
              ctx,
              {
                kind: "error",
                area: "a cleanup job",
                detail: `“${name}” failed. Relay tries again on its next round.`,
              },
              null,
              `maintenance:${name}`,
            );
          });
      })()
        .catch((error) => app.log.error({ err: error }, "maintenance sweep failed"))
        .finally(() => (sweeping = null)));

    const reconciled = await ctx.blobs.reconcile();
    ctx.operations.reconciliation = {
      checked: Date.now(),
      missing: reconciled.missing.length,
      removedOrphans: reconciled.removedFiles,
    };
    if (reconciled.missing.length) app.log.error({ missing: reconciled.missing.length }, "blobs missing from disk");
    await ctx.transfers.recover();
    await sweep();
    timer = setInterval(() => void sweep(), config.sweepMs);
    timer.unref();
    const recovery = issueRecovery(ctx);
    if (recovery) app.log.warn(recovery.message);

    const dist = resolve("dist");
    if (config.serveClient && existsSync(dist)) {
      await app.register(staticFiles, {
        root: dist,
        prefix: "/",
        wildcard: false,
        // The build stores Brotli and gzip copies of each text file (see vite.config.ts). They are
        // chosen by Accept-Encoding, never asked for by name.
        preCompressed: true,
        allowedPath: (path) => !/\.(br|gz)$/.test(path),
        setHeaders(reply, path) {
          const file = path.replace(/\.(br|gz)$/, "");
          const fingerprinted = file.startsWith(join(dist, "assets") + "/") && /-[\w-]{8,}\.[\w]+$/.test(file);
          reply.header("Cache-Control", fingerprinted ? "public, max-age=31536000, immutable" : "no-cache");
        },
      });
      // /local/ belongs to the direct download worker (public/local-sw.js); what it doesn't serve is gone.
      app.setNotFoundHandler((req, reply) =>
        ["/api/", "/uploads/", "/assets/", "/local/"].some((prefix) => req.url.startsWith(prefix))
          ? reply.code(404).send({ error: "Not found." })
          : reply.type("text/html").sendFile("index.html"),
      );
    }
    return { app, ctx, sweep };
  } catch (error) {
    // Startup can fail during recovery or plugin registration. Release timers and the exclusive lock.
    try {
      await app.close();
    } catch {
      /* Preserve the startup failure. */
    }
    db.close();
    throw error;
  }
}

/** Filesystem or SQLite writes that failed for lack of space (SQLITE_FULL is 13). */
function isOutOfSpace(error: unknown): boolean {
  const { code, errcode } = error as { code?: string; errcode?: number };
  return code === "ENOSPC" || code === "EDQUOT" || errcode === 13;
}

/** Where a failed request was, in the words of the app rather than its address. */
const AREAS: [RegExp, string][] = [
  [/^\/api\/(uploads|transfers|tabs)\b/, "uploading files"],
  [/^\/api\/(items|trash)\b|\/(download|zip|preview|thumbnail)/, "Files"],
  [/^\/api\/(links|s)\b|^\/s\//, "shared links"],
  [/^\/api\/(requests|r)\b|^\/r\//, "requests"],
  [/^\/api\/(deliveries|devices)\b/, "sending to devices"],
  [/^\/api\/(nearby|n|local)\b/, "Nearby and Direct"],
  [/^\/api\/(session|login-codes|invitations|setup|recover|account)\b|^\/auth\//, "signing in and accounts"],
  [/^\/api\/admin\b/, "Admin"],
];
function areaOf(route: string | undefined) {
  return AREAS.find(([pattern]) => route && pattern.test(route))?.[1] ?? "the app";
}
