// Bounded image renditions keyed by blob hash, so previews never ship originals. A few long-lived
// workers render one image each at a time; requests wait their turn, taken in rotation between the
// people asking, and a request for a rendition already in progress waits for that one.
import { createReadStream, readFileSync, writeFileSync, type Stats } from "node:fs";
import { availableParallelism } from "node:os";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../../context.ts";
import { authOf } from "../../lib/auth.ts";
import { fail } from "../../lib/errors.ts";
import {
  sameFile,
  thumbnailAttempt,
  thumbnailFailure,
  thumbnailPath,
  type ThumbnailDecoder,
} from "../../storage/blobs.ts";
import { unlinkIfPresent } from "../../storage/files.ts";

const DIMENSIONS = { s: 640, l: 2048 } as const;
type Size = keyof typeof DIMENSIONS;
export const MAX_SOURCE_BYTES = 50 * 1024 ** 2;
export const MAX_PIXELS = 50_000_000;
export const MAX_HEIF_PIXELS = 40_000_000;
/**
 * AVIF, which sharp decodes whole: about 14 bytes of memory per pixel, from files of a few hundred
 * bytes. 16 MP (about 250 MB) covers photos and 4K screenshots.
 */
export const MAX_AVIF_PIXELS = 16_000_000;
/** Times Relay may stop mid-render of one image before that image is no longer tried. */
const INTERRUPTED_RENDERS = 2;
/** Images rendered at once. Two on a Raspberry Pi's four cores leaves the rest for transfers. */
const RENDERERS = Math.max(1, Math.min(2, availableParallelism() - 2));
/**
 * Renditions waiting, in all and for one person. A phone opening an album asks for every visible
 * photo at once; they wait their turn instead of failing. Past these, the page retries.
 */
export const MAX_QUEUED_RENDITIONS = 512;
export const MAX_QUEUED_PER_PERSON = 128;
/** An idle worker is stopped after this long, so its memory is returned when nobody is browsing. */
const WORKER_IDLE_MS = 30_000;
/** Renders before a worker is replaced, bounding what any slow leak can hold. */
const RENDERS_PER_WORKER = 200;

const TYPES = /^image\/(png|jpeg|webp|gif|avif|heic|heif)$/;
const EXTENSIONS = /\.(png|jpe?g|webp|gif|avif|heic|heif)$/i;
const HEIF = /^image\/hei[cf]$|\.hei[cf]$/i;
const WORKER_TIMEOUT_MS = 15_000;
export const RENDITION_RETRY_MS = 5_000;
const DETERMINISTIC_FAILURES = new Set(["INVALID_IMAGE", "SOURCE_TOO_LARGE", "HEIF_DIMENSIONS_TOO_LARGE"]);

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

type RenderInput = { source: string; target: string; format: ThumbnailDecoder; width: number };
type Renderer = { worker: Worker; renders: number; idle?: NodeJS.Timeout };

/**
 * Long-lived render workers. Starting a worker costs about as much as rendering a photo, so one is
 * reused until it idles, has rendered many images, or rendered a HEIF photo (whose decoder keeps
 * its memory). A worker that fails or times out is stopped and never reused.
 */
function createRenderers() {
  const idle: Renderer[] = [];
  const all = new Set<Renderer>();
  let ids = 0;
  let closed = false;

  const retire = (renderer: Renderer) => {
    clearTimeout(renderer.idle);
    all.delete(renderer);
    const index = idle.indexOf(renderer);
    if (index !== -1) idle.splice(index, 1);
    void renderer.worker.terminate();
  };

  const spawn = () => {
    const worker = new Worker(new URL("./thumbnail-worker.ts", import.meta.url), {
      workerData: {
        maxSourceBytes: MAX_SOURCE_BYTES,
        maxPixels: MAX_PIXELS,
        maxHeifPixels: MAX_HEIF_PIXELS,
        maxAvifPixels: MAX_AVIF_PIXELS,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    // An idle worker never keeps Relay from exiting.
    worker.unref?.();
    const renderer: Renderer = { worker, renders: 0 };
    all.add(renderer);
    worker.on("error", () => retire(renderer));
    worker.once("exit", () => retire(renderer));
    return renderer;
  };

  function render(input: RenderInput) {
    const renderer = idle.pop() ?? spawn();
    clearTimeout(renderer.idle);
    const id = ++ids;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (healthy: boolean, outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        renderer.worker.off("message", answered);
        renderer.worker.off("error", failed);
        renderer.worker.off("exit", exited);
        renderer.renders++;
        if (healthy && !closed && input.format !== "heif" && renderer.renders < RENDERS_PER_WORKER) {
          renderer.idle = setTimeout(() => retire(renderer), WORKER_IDLE_MS);
          renderer.idle.unref();
          idle.push(renderer);
        } else retire(renderer);
        outcome();
      };
      const timer = setTimeout(
        () => finish(false, () => reject(new WorkerRenderError("WORKER_TIMEOUT", "thumbnail rendering timed out"))),
        WORKER_TIMEOUT_MS,
      );
      const answered = (message: { id: number; ok: boolean; code?: string; message?: string }) => {
        if (message.id !== id) return;
        finish(true, () =>
          message.ok
            ? resolve()
            : reject(new WorkerRenderError(message.code ?? "RENDER_FAILED", message.message ?? "render failed")),
        );
      };
      const failed = (error: Error) => finish(false, () => reject(error));
      const exited = (code: number) =>
        finish(false, () => reject(new WorkerRenderError("WORKER_EXIT", `thumbnail worker exited with ${code}`)));
      renderer.worker.on("message", answered);
      renderer.worker.on("error", failed);
      renderer.worker.on("exit", exited);
      renderer.worker.postMessage({ id, ...input });
    });
  }

  return {
    render,
    close() {
      closed = true;
      for (const renderer of [...all]) retire(renderer);
    },
  };
}

export function createThumbnails(ctx: Context) {
  type Job = {
    key: string;
    /** Who asked first: the queue the job waits in. */
    person: string;
    state: "waiting" | "active" | "done" | "cancelled";
    waiters: number;
    work: () => Promise<string>;
    promise: Promise<string>;
    resolve: (file: string) => void;
    reject: (error: unknown) => void;
  };
  const renderers = createRenderers();
  const inflight = new Map<string, Job>();
  /** Waiting jobs per person, in the order their turns come round. */
  const waiting = new Map<string, Job[]>();
  let queued = 0;
  let active = 0;
  // Temporary outages are never persisted and have a short shared backoff for both sizes.
  const retryAfter = new Map<string, number>();
  const busy = () => fail(503, "Preview rendering is temporarily unavailable. Retry shortly.");
  /** Renders in progress per attempt note, so both sizes of one image share it. */
  const attempts = new Map<string, number>();

  /**
   * Notes on disk that an image is being decoded, until it's done. If a decoder takes so much
   * memory that Relay is stopped, the note survives the restart; an image that was being decoded
   * at two such stops isn't tried again, so one file can't keep Relay restarting. Returns null for
   * such an image, otherwise a function to call when the render ends.
   */
  function beginAttempt(sha256: string, format: ThumbnailDecoder) {
    const note = thumbnailAttempt(ctx.config.root, sha256, format);
    const running = attempts.get(note) ?? 0;
    if (!running) {
      let stops = 0;
      try {
        stops = (Number(readFileSync(note, "utf8")) || 0) + 1;
      } catch {
        // No note: the last render of this image finished.
      }
      if (stops >= INTERRUPTED_RENDERS) {
        unlinkIfPresent(note);
        return null;
      }
      writeFileSync(note, String(stops));
    }
    attempts.set(note, running + 1);
    return () => {
      const left = attempts.get(note)! - 1;
      if (left) return attempts.set(note, left);
      attempts.delete(note);
      unlinkIfPresent(note);
    };
  }

  const unchanged = async (sha256: string, before: Stats) => {
    const after = await stat(ctx.blobs.path(sha256)).catch(() => null);
    return after !== null && sameFile(before, after);
  };

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

  /** The next waiting job, taking one from each person in turn. */
  function nextWaiting() {
    for (const [person, jobs] of waiting) {
      const job = jobs.shift()!;
      queued--;
      waiting.delete(person);
      if (jobs.length) waiting.set(person, jobs);
      return job;
    }
  }

  function startWaiting() {
    while (active < RENDERERS) {
      const next = nextWaiting();
      if (!next) return;
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
    const jobs = waiting.get(job.person);
    const index = jobs?.indexOf(job) ?? -1;
    if (index !== -1) {
      jobs!.splice(index, 1);
      queued--;
      if (!jobs!.length) waiting.delete(job.person);
    }
    if (inflight.get(job.key) === job) inflight.delete(job.key);
  }

  function getJob(key: string, person: string, work: () => Promise<string>, reply: FastifyReply) {
    const existing = inflight.get(key);
    if (existing) return existing;
    const mine = waiting.get(person)?.length ?? 0;
    if (active >= RENDERERS && (queued >= MAX_QUEUED_RENDITIONS || mine >= MAX_QUEUED_PER_PERSON)) {
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
    const job: Job = { key, person, state: "waiting", waiters: 0, work, promise, resolve, reject };
    inflight.set(key, job);
    if (active < RENDERERS) start(job);
    else {
      const jobs = waiting.get(person);
      if (jobs) jobs.push(job);
      else waiting.set(person, [job]);
      queued++;
    }
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

  async function cacheFailure(sha256: string, format: ThumbnailDecoder, sourceInfo: Stats, temporary: string) {
    const marker = thumbnailFailure(ctx.config.root, sha256, format);
    await writeFile(temporary, "This image cannot be previewed.\n");
    if (!(await unchanged(sha256, sourceInfo))) return busy();
    await rename(temporary, marker);
    if (!(await unchanged(sha256, sourceInfo))) return busy();
  }

  async function render(sha256: string, size: Size, format: ThumbnailDecoder) {
    const target = thumbnailPath(ctx.config.root, sha256, size);
    if (await exists(target)) {
      if (ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) return target;
      await unlink(target).catch(() => {});
      fail(404, "The stored file is unavailable.");
    }
    if (await exists(thumbnailFailure(ctx.config.root, sha256, format))) {
      if (ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) fail(415, "This image cannot be previewed.");
      await unlink(thumbnailFailure(ctx.config.root, sha256, format)).catch(() => {});
      fail(404, "The stored file is unavailable.");
    }
    const source = ctx.blobs.path(sha256);
    const publication = ctx.blobs.stageThumbnail(sha256);
    try {
      const info = await stat(source).catch(busy);
      const cacheRejection = async () => {
        await cacheFailure(sha256, format, info, publication.file);
        publication.finish();
      };
      if (info.size > MAX_SOURCE_BYTES) {
        await cacheRejection();
        fail(415, "This image is too large to preview.");
      }
      const ended = beginAttempt(sha256, format);
      if (!ended) {
        ctx.log.warn({ blob: sha256 }, "Relay stopped while previewing this image before; it won't be tried again");
        await cacheRejection();
        fail(415, "This image cannot be previewed.");
      }
      try {
        await renderers.render({ source, target: publication.file, format, width: DIMENSIONS[size] });
        if (!(await unchanged(sha256, info))) return busy();
        await rename(publication.file, target);
        if (!(await unchanged(sha256, info))) return busy();
        publication.finish();
        return target;
      } catch (error) {
        if ((error as { status?: number }).status) throw error;
        if (!ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256)) fail(404, "The stored file is unavailable.");
        if (error instanceof WorkerRenderError && DETERMINISTIC_FAILURES.has(error.code)) {
          await cacheRejection();
          return fail(415, "This image cannot be previewed.");
        }
        ctx.log.error({ err: error, blob: sha256 }, "thumbnail render unavailable; retry required");
        if (retryAfter.size >= 256) retryAfter.delete(retryAfter.keys().next().value!);
        retryAfter.set(sha256, Date.now() + RENDITION_RETRY_MS);
        return busy();
      } finally {
        ended();
      }
    } finally {
      try {
        publication.discard();
      } catch (error) {
        ctx.log.error({ err: error, blob: sha256 }, "thumbnail cleanup pending; blob cleanup will retry");
      }
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

  async function send(req: FastifyRequest, reply: FastifyReply, node: ThumbnailSource) {
    const size: Size = (req.query as { size?: string }).size === "l" ? "l" : "s";
    const format = node.kind === "file" && node.blob ? kind(node.mime, node.name) : null;
    if (!format || !node.blob) return fail(415, "There is no image preview for this file.");
    await ctx.blobs.verify(node.blob);
    if ((retryAfter.get(node.blob) ?? 0) > Date.now()) {
      reply.header("Retry-After", Math.ceil(((retryAfter.get(node.blob) ?? 0) - Date.now()) / 1000));
      return busy();
    }
    retryAfter.delete(node.blob);
    const etag = `"${node.blob}-${size}"`;
    reply.header("ETag", etag).header("Cache-Control", "private, max-age=86400");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    const target = thumbnailPath(ctx.config.root, node.blob, size);
    if (await exists(target)) return sendFile(req, reply, node.blob, target);
    const marker = thumbnailFailure(ctx.config.root, node.blob, format);
    if (await exists(marker)) {
      if (ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", node.blob)) fail(415, "This image cannot be previewed.");
      await unlink(marker).catch(() => {});
      fail(404, "The stored file is unavailable.");
    }
    // A filename/MIME hint selects the decoder, so distinct decoder attempts cannot share failure.
    const key = `${node.blob}-${size}-${format}`;
    // A member's requests share one turn wherever they come from; anyone else's, by address.
    const person = authOf(ctx, req).member?.userId ?? `ip:${req.ip}`;
    const job = getJob(key, person, () => render(node.blob!, size, format), reply);
    let file: string | null;
    try {
      file = await waitForJob(job, req, reply);
    } catch (error) {
      if ((error as { status?: number }).status === 503)
        reply.header("Retry-After", Math.ceil(RENDITION_RETRY_MS / 1000));
      throw error;
    }
    if (!file) return;
    return sendFile(req, reply, node.blob, file);
  }

  return Object.assign(send, { close: () => renderers.close() });
}
