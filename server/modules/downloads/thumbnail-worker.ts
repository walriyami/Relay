import { readFile, stat, writeFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import { ALLOWED_LOADERS, imageSignature } from "./image-signature.ts";

/** One rendition to make. A worker renders many, one at a time. */
type Job = { id: number; source: string; target: string; format: "heif" | "image"; width: number };
type Limits = { maxSourceBytes: number; maxPixels: number; maxHeifPixels: number };

const limits = workerData as Limits;
sharp.cache(false);
sharp.concurrency(1);
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({ operation: ALLOWED_LOADERS });

async function render(job: Job) {
  const data = { ...job, ...limits };
  const sourceInfo = await stat(data.source);
  if (sourceInfo.size > data.maxSourceBytes) {
    const error = new Error("The source image is too large to preview.");
    (error as Error & { code: string }).code = "SOURCE_TOO_LARGE";
    throw error;
  }

  // Reading and writing are separate from decoding so filesystem failures cannot be mistaken
  // for a deterministic invalid-image result from the decoder.
  const buffer = await readFile(data.source);
  // Only the formats Relay previews, judged by their bytes rather than the name or type the uploader gave.
  const signature = imageSignature(buffer.subarray(0, 16));
  if (!signature || (data.format === "heif" && signature !== "heif"))
    throw Object.assign(new Error("This image format cannot be previewed."), { code: "INVALID_IMAGE" });
  if (data.format === "image") {
    const image = sharp(buffer, {
      limitInputPixels: data.maxPixels,
      failOn: "none",
      animated: false,
    });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp", "gif", "heif"].includes(metadata.format ?? ""))
      throw Object.assign(new Error("This image format cannot be previewed."), { code: "INVALID_IMAGE" });
    const output = await image
      .rotate()
      .resize({ width: data.width, height: data.width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: data.width === 640 ? 72 : 84 })
      .toBuffer();
    await writeFile(data.target, output);
    return;
  }

  // Read only after the source-size check and inspect dimensions before libheif allocates pixels.
  // Loaded here, not up front: most images are not HEIF, and a worker retires after a HEIF render.
  const { default: decodeHeic } = await import("heic-decode");
  const images = await decodeHeic.all({ buffer });
  if (!images.length) throw Object.assign(new Error("HEIF image not found"), { code: "INVALID_IMAGE" });
  const primary = images[0];
  try {
    // libheif exposes metadata before display() allocates the RGBA pixel buffer.
    if (primary.width * primary.height > data.maxHeifPixels) {
      const error = new Error("This image is too large to preview.");
      (error as Error & { code: string }).code = "HEIF_DIMENSIONS_TOO_LARGE";
      throw error;
    }
    const image = await primary.decode();
    if (image.width * image.height > data.maxHeifPixels) {
      const error = new Error("This image is too large to preview.");
      (error as Error & { code: string }).code = "HEIF_DIMENSIONS_TOO_LARGE";
      throw error;
    }
    const pixels = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    const output = await sharp(pixels, { raw: { width: image.width, height: image.height, channels: 4 } })
      .resize({ width: data.width, height: data.width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: data.width === 640 ? 72 : 84 })
      .toBuffer();
    await writeFile(data.target, output);
  } finally {
    images.dispose?.();
  }
}

parentPort?.on("message", (job: Job) => {
  render(job).then(
    () => parentPort!.postMessage({ id: job.id, ok: true }),
    (error: unknown) =>
      parentPort!.postMessage({
        id: job.id,
        ok: false,
        code:
          (error as { code?: string }).code ??
          (/unsupported image format|exceeds pixel limit|corrupt header|invalid (?:image|jpeg|png|header)|not a HEIC image|premature end/i.test(
            String((error as Error).message),
          )
            ? "INVALID_IMAGE"
            : "RENDER_FAILED"),
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});
