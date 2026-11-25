import { readFile, stat, writeFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";
import type HeicDecode from "heic-decode";
import sharp from "sharp";
import { ALLOWED_LOADERS, imageSignature } from "./image-signature.ts";
import { MAX_HEIF_PIXELS, MAX_PIXELS, MAX_SOURCE_BYTES, decodeRefusal, jpegLayout } from "./image-limits.ts";

/** One rendition to make. A worker renders many, one at a time. */
type Job = { id: number; source: string; target: string; format: "heif" | "image"; width: number };

sharp.cache(false);
sharp.concurrency(1);
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({ operation: ALLOWED_LOADERS });

/** A result that depends only on the file's bytes, so it is the same every time. */
const invalid = (message: string, code = "INVALID_IMAGE") => Object.assign(new Error(message), { code });

type HeicDecoder = typeof HeicDecode;

/**
 * Decoding and encoding, from bytes already read to bytes to write. Whatever a decoder rejects here
 * would be rejected again on every try, so an error without a code of Relay's own is the image's
 * unless it says memory ran short.
 */
async function rendition(buffer: Buffer, job: Job, decodeHeic: HeicDecoder | null) {
  // Only the formats Relay previews, judged by their bytes rather than the name or type the uploader gave.
  const signature = imageSignature(buffer.subarray(0, 16));
  if (!signature || (job.format === "heif" && signature !== "heif"))
    throw invalid("This image format cannot be previewed.");
  if (job.format === "image") {
    const image = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "none", animated: false });
    // Read from the header alone; nothing is decoded until the image is known to fit.
    const metadata = await image.metadata();
    const refusal = decodeRefusal(metadata, metadata.format === "jpeg" ? jpegLayout(buffer) : null);
    if (refusal) throw invalid(refusal, "IMAGE_TOO_COSTLY");
    return image
      .rotate()
      .resize({ width: job.width, height: job.width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: job.width === 640 ? 72 : 84 })
      .toBuffer();
  }

  const images = await decodeHeic!.all({ buffer });
  if (!images.length) throw invalid("HEIF image not found");
  const primary = images[0];
  try {
    // libheif exposes the size before display() allocates the RGBA pixel buffer.
    if (primary.width * primary.height > MAX_HEIF_PIXELS)
      throw invalid("This image is too large to preview.", "HEIF_DIMENSIONS_TOO_LARGE");
    const image = await primary.decode();
    if (image.width * image.height > MAX_HEIF_PIXELS)
      throw invalid("This image is too large to preview.", "HEIF_DIMENSIONS_TOO_LARGE");
    const pixels = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    return await sharp(pixels, { raw: { width: image.width, height: image.height, channels: 4 } })
      .resize({ width: job.width, height: job.width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: job.width === 640 ? 72 : 84 })
      .toBuffer();
  } finally {
    images.dispose?.();
  }
}

async function render(job: Job) {
  const sourceInfo = await stat(job.source);
  if (sourceInfo.size > MAX_SOURCE_BYTES)
    throw invalid("The source image is too large to preview.", "SOURCE_TOO_LARGE");
  // Reading and writing stay outside the decoding step, so a disk problem keeps its own code and is
  // retried, and is never taken for an image that can't be previewed.
  const buffer = await readFile(job.source);
  // Loaded only for HEIF: most images aren't, and a worker retires after a HEIF render. A failure
  // to load it is Relay's, not the image's.
  const decodeHeic = job.format === "heif" ? (await import("heic-decode")).default : null;
  const output = await rendition(buffer, job, decodeHeic).catch((error: unknown) => {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // Running short of memory says nothing about the image, so that alone is tried again later.
    if (/out of memory|cannot allocate|allocation failed/i.test(message))
      throw Object.assign(new Error(message), { code: "RENDER_FAILED" });
    throw invalid(message);
  });
  await writeFile(job.target, output);
}

parentPort?.on("message", (job: Job) => {
  render(job).then(
    () => parentPort!.postMessage({ id: job.id, ok: true }),
    (error: unknown) =>
      parentPort!.postMessage({
        id: job.id,
        ok: false,
        code: (error as { code?: string }).code ?? "RENDER_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});
