import Fastify, { LogController, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { core as zod } from "zod/mini";
import type { Config } from "./config.ts";
import type { Context } from "./context.ts";
import { Database } from "./db/database.ts";
import { EventBus } from "./lib/events.ts";
import { HttpError } from "./lib/errors.ts";
import { Secrets } from "./lib/secrets.ts";
import { checkCsrf, sessionCookie, memberFromToken } from "./lib/auth.ts";
import { route } from "./lib/http.ts";
import { api } from "../shared/api.ts";
import { createBlobStore } from "./storage/blobs.ts";
import { createLibrary, registerLibrary } from "./modules/library/index.ts";
import { createTransfers, registerTransfers } from "./modules/transfers/index.ts";
import { registerDownloads } from "./modules/downloads/index.ts";
import { addressKey } from "./modules/auth/limits.ts";
import { ensureAdmin, registerAuth, sweepAuth } from "./modules/auth/index.ts";
import { createLinks, registerLinks } from "./modules/links/index.ts";
import { registerCodes } from "./modules/codes/index.ts";
import { createDeliveries, registerDeliveries } from "./modules/deliveries/index.ts";
import { registerRequests } from "./modules/requests/index.ts";
import { registerAdmin } from "./modules/admin/index.ts";
import { createActivity, registerActivity } from "./modules/activity/index.ts";
import { Operations } from "./lib/operations.ts";
import { Backups } from "./modules/backup/index.ts";

export type App = { app: FastifyInstance; ctx: Context; backups: Backups; sweep: () => Promise<void> };

export async function buildApp(config: Config): Promise<App> {
  for (const dir of ["", "blobs", "uploads", "thumbnails"])
    mkdirSync(join(config.root, dir), { recursive: true, mode: 0o700 });
  const db = new Database(join(config.root, "relay.sqlite"));
  const app = Fastify({
    logger: config.logger ? { level: "info", redact: ["req.headers.cookie", "req.headers['x-relay-csrf']"] } : false,
    // Fastify's own request lines include raw URLs; the onResponse hook below logs routes instead.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustProxy,
  });

  // Services reference each other through ctx, so construction order does not matter.
  const ctx = {
    config,
    db,
    operations: new Operations(config.sweepMs),
    secrets: new Secrets(config.root, config.secret),
    events: new EventBus(),
    log: app.log,
  } as Context;
  ctx.blobs = createBlobStore(ctx);
  ctx.library = createLibrary(ctx);
  ctx.transfers = createTransfers(ctx);
  ctx.links = createLinks(ctx);
  ctx.deliveries = createDeliveries(ctx);
  ctx.activity = createActivity(ctx);
  const backups = new Backups(ctx);
  await ensureAdmin(ctx);

  await app.register(cookie);
  await app.register(rateLimit, {
    max: 6000,
    timeWindow: "1 minute",
    // One bucket per IPv4 address or IPv6 /64, so an IPv6 host cannot rotate addresses.
    keyGenerator: (req) => addressKey(req.ip),
    // Signed-in members are trusted; the limit protects anonymous surfaces.
    allowList: (req) => !!memberFromToken(ctx, req.cookies?.[sessionCookie(ctx)]),
  });

  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    checkCsrf(ctx, req, req.routeOptions.config ?? {});
  });
  // Log the route pattern, never the raw URL: link and request tokens travel in paths.
  app.addHook("onResponse", async (req, reply) => {
    if (!req.routeOptions.url || req.routeOptions.url === "/api/health") return;
    ctx.operations.response(reply.statusCode);
    req.log.info(
      { method: req.method, route: req.routeOptions.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
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
      return reply.code(507).send({ error: "The server's disk is full. Retry after space is freed." });
    }
    req.log.error({ err: error, route: req.routeOptions.url }, "request failed");
    return reply.code(500).send({ error: "The operation could not finish. Retry or contact the administrator." });
  });

  route(app, ctx, api.health, () => {
    db.value("SELECT 1");
    return { ok: true as const };
  });
  registerAuth(app, ctx);
  registerLibrary(app, ctx);
  registerTransfers(app, ctx);
  registerDownloads(app, ctx);
  registerLinks(app, ctx);
  registerCodes(app, ctx);
  registerDeliveries(app, ctx);
  registerRequests(app, ctx);
  registerAdmin(app, ctx);
  registerActivity(app, ctx);

  let sweeping: Promise<void> | null = null;
  const sweep = () =>
    (sweeping ??= (async () => {
      const now = Date.now();
      const stages: [string, () => unknown][] = [
        ["Library retention", () => ctx.library.sweep(now)],
        ["Upload cleanup", () => ctx.transfers.sweep(now)],
        ["Session cleanup", () => sweepAuth(ctx, now)],
        ["Activity cleanup", () => ctx.activity.sweep(now)],
      ];
      // One failed job must not prevent unrelated cleanup from running.
      for (const [name, work] of stages)
        await ctx.operations.run(name, work, (error) =>
          app.log.error({ err: error, stage: name }, "maintenance failed"),
        );
      backups.maybeRun(now);
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
  const timer = setInterval(() => void sweep(), config.sweepMs);
  timer.unref();

  app.addHook("preClose", async () => {
    clearInterval(timer);
    await sweeping;
    await backups.close();
    ctx.events.close();
  });
  app.addHook("onClose", () => db.close());

  const dist = resolve("dist");
  if (config.serveClient && existsSync(dist)) {
    await app.register(staticFiles, { root: dist, prefix: "/", wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") || req.url.startsWith("/uploads/")
        ? reply.code(404).send({ error: "Not found." })
        : reply.type("text/html").sendFile("index.html"),
    );
  }
  return { app, ctx, backups, sweep };
}

/** Filesystem or SQLite writes that failed for lack of space (SQLITE_FULL is 13). */
function isOutOfSpace(error: unknown): boolean {
  const { code, errcode } = error as { code?: string; errcode?: number };
  return code === "ENOSPC" || code === "EDQUOT" || errcode === 13;
}
