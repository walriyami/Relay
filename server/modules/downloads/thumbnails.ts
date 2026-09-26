// Bounded image renditions keyed by blob hash, so previews never ship originals. Rendering runs at
// one at a time and a request for a rendition already in progress waits for that one.
import { createReadStream } from "node:fs";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { uuidv7 } from "../../../shared/ids.ts";
import type { Context } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { thumbnailFailure, thumbnailPath } from "../../storage/blobs.ts";

const DIMENSIONS = { s: 640, l: 2048 } as const;
type Size = keyof typeof DIMENSIONS;
export const MAX_SOURCE_BYTES = 50 * 1024 ** 2;
export const MAX_PIXELS = 50_000_000;
export const MAX_HEIF_PIXELS = 40_000_000;
const RENDERERS = 1;
export const MAX_QUEUED_RENDITIONS = 32;

const TYPES = /^image\/(png|jpeg|webp|gif|avif|heic|heif)$/;
const EXTENSIONS = /\.(png|jpe?g|webp|gif|avif|heic|heif)$/i;
const HEIF = /^image\/hei[cf]$|\.hei[cf]$/i;
const WORKER_TIMEOUT_MS = 15_000;

const kind = (mime: string, name: string) => {
  const type = mime.split(";")[0].trim().toLowerCase();
  if (!TYPES.test(type) && !EXTENSIONS.test(name)) return null;
  return HEIF.test(type) || HEIF.test(name) ? "heif" : "image";
};

export type ThumbnailSource = { kind: string; name: string; mime: string; blob: string | null };

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

class WorkerRenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function renderInWorker(input: { source: string; target: string; format: "heif" | "image"; width: number }) {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL("./thumbnail-worker.ts", import.meta.url), {
      workerData: {
        ...input,
        maxSourceBytes: MAX_SOURCE_BYTES,
        maxPixels: MAX_PIXELS,
        maxHeifPixels: MAX_HEIF_PIXELS,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker
        .terminate()
        .finally(() => reject(new WorkerRenderError("WORKER_TIMEOUT", "thumbnail rendering timed out")));
    }, WORKER_TIMEOUT_MS);
    worker.once("message", (message: { ok: boolean; code?: string; message?: string }) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      void worker.terminate().then(() => {
        if (message.ok) resolve();
        else reject(new WorkerRenderError(message.code ?? "RENDER_FAILED", message.message ?? "render failed"));
      }, reject);
    });
    worker.once("error", (error: Error) => {
      clearTimeout(timer);
      settled = true;
      void worker.terminate();
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (!settled && code !== 0) reject(new WorkerRenderError("WORKER_EXIT", `thumbnail worker exited with ${code}`));
      else if (!settled) reject(new WorkerRenderError("WORKER_EXIT", "thumbnail worker exited before rendering"));
    });
  });
}

export function createThumbnails(ctx: Context) {
  type Job = {
    key: string;
    state: "waiting" | "active" | "done" | "cancelled";
    waiters: number;
    work: () => Promise<string>;
    promise: Promise<string>;
    resolve: (file: string) => void;
    reject: (error: unknown) => void;
  };
  const inflight = new Map<string, Job>();
  const waiting: Job[] = [];
  let active = 0;

  function start(job: Job) {
    job.state = "active";
    active++;
    void Promise.resolve()
      .then(job.work)
      .then(job.resolve, job.reject)
      .finally(() => {
        job.state = "done";
        if (inflight.get(job.key) === job) inflight.delete(job.key);
        active--;
        startWaiting();
      });
  }

  function startWaiting() {
    while (active < RENDERERS && waiting.length) {
      const next = waiting.shift()!;
      if (next.state !== "waiting") continue;
      if (next.waiters === 0) {
        next.state = "cancelled";
        if (inflight.get(next.key) === next) inflight.delete(next.key);
        continue;
      }
      start(next);
    }
  }

  function cancelIfUnobserved(job: Job) {
    if (job.waiters !== 0 || job.state !== "waiting") return;
    job.state = "cancelled";
    const index = waiting.indexOf(job);
    if (index !== -1) waiting.splice(index, 1);
    if (inflight.get(job.key) === job) inflight.delete(job.key);
  }

  function getJob(key: string, work: () => Promise<string>, reply: FastifyReply) {
    const existing = inflight.get(key);
    if (existing) return existing;
    if (active >= RENDERERS && waiting.length >= MAX_QUEUED_RENDITIONS) {
      reply.header("Retry-After", "1");
      fail(503, "Preview rendering is busy. Retry shortly.");
    }
    let resolve!: (file: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // An active render can finish after every interested request disconnects.
    void promise.catch(() => {});
    const job: Job = { key, state: "waiting", waiters: 0, work, promise, resolve, reject };
    inflight.set(key, job);
    if (active < RENDERERS) start(job);
    else waiting.push(job);
    return job;
  }

  function waitForJob(job: Job, req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    job.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        req.raw.off("aborted", disconnected);
        reply.raw.off("close", responseClosed);
      };
      const disconnected = () => {
        if (settled) return;
        settled = true;
        cleanup();
        job.waiters--;
        cancelIfUnobserved(job);
        resolve(null);
      };
      const responseClosed = () => {
        if (!reply.raw.writableEnded) disconnected();
      };
      req.raw.once("aborted", disconnected);
      reply.raw.once("close", responseClosed);
      if (req.raw.aborted || reply.raw.destroyed) disconnected();
      job.promise.then(
        (file) => {
          if (settled) return;
          settled = true;
          cleanup();
          job.waiters--;
          resolve(file);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          job.waiters--;
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async function cacheFailure(sha256: string) {
    if (!ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) return;
    const marker = thumbnailFailure(ctx.config.root, sha256);
    const temporary = join(ctx.config.root, "thumbnails", `.${uuidv7()}.failed.tmp`);
    try {
      await writeFile(temporary, "This image cannot be previewed.\n");
      await rename(temporary, marker);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    if (!ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) await unlink(marker).catch(() => {});
  }

  async function render(sha256: string, size: Size, format: "heif" | "image") {
    const target = thumbnailPath(ctx.config.root, sha256, size);
    if (await exists(target)) {
      if (ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) return target;
      await unlink(target).catch(() => {});
      fail(404, "The stored file is unavailable.");
    }
    if (await exists(thumbnailFailure(ctx.config.root, sha256))) {
      if (ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) fail(415, "This image cannot be previewed.");
      await unlink(thumbnailFailure(ctx.config.root, sha256)).catch(() => {});
      fail(404, "The stored file is unavailable.");
    }
    const source = ctx.blobs.path(sha256);
    const info = await stat(source).catch(() => fail(404, "The stored file is unavailable."));
    if (info.size > MAX_SOURCE_BYTES) {
      await cacheFailure(sha256);
      fail(415, "This image is too large to preview.");
    }
    const temporary = join(ctx.config.root, "thumbnails", `.${uuidv7()}.tmp`);
    try {
      await renderInWorker({ source, target: temporary, format, width: DIMENSIONS[size] });
      if (!ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) {
        await unlink(temporary).catch(() => {});
        await unlink(target).catch(() => {});
        fail(404, "The stored file is unavailable.");
      }
      await rename(temporary, target);
      if (!ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) {
        await unlink(target).catch(() => {});
        fail(404, "The stored file is unavailable.");
      }
      return target;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      if ((error as { status?: number }).status) throw error;
      if (!ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) fail(404, "The stored file is unavailable.");
      await cacheFailure(sha256);
      return fail(415, "This image cannot be previewed.");
    }
  }

  async function sendFile(req: FastifyRequest, reply: FastifyReply, sha256: string, file: string) {
    if (!ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) {
      await unlink(file).catch(() => {});
      return fail(404, "The stored file is unavailable.");
    }
    const { size: length } = await stat(file).catch(() => fail(404, "The stored file is unavailable."));
    reply.type("image/webp").header("Content-Length", length);
    return req.method === "HEAD" ? reply.send() : reply.send(createReadStream(file));
  }

  return async function send(req: FastifyRequest, reply: FastifyReply, node: ThumbnailSource) {
    const size: Size = (req.query as { size?: string }).size === "l" ? "l" : "s";
    const format = node.kind === "file" && node.blob ? kind(node.mime, node.name) : null;
    if (!format || !node.blob) return fail(415, "There is no image preview for this file.");
    const etag = `"${node.blob}-${size}"`;
    reply.header("ETag", etag).header("Cache-Control", "private, max-age=86400");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    const target = thumbnailPath(ctx.config.root, node.blob, size);
    if (await exists(target)) return sendFile(req, reply, node.blob, target);
    const marker = thumbnailFailure(ctx.config.root, node.blob);
    if (await exists(marker)) {
      if (ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", node.blob)) fail(415, "This image cannot be previewed.");
      await unlink(marker).catch(() => {});
      fail(404, "The stored file is unavailable.");
    }
    const key = `${node.blob}-${size}`;
    const job = getJob(key, () => render(node.blob!, size, format), reply);
    const file = await waitForJob(job, req, reply);
    if (!file) return;
    return sendFile(req, reply, node.blob, file);
  };
}
