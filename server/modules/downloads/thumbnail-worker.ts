import { readFile, stat } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import decodeHeic from "heic-decode";
import sharp from "sharp";

type WorkerInput = {
  source: string;
  target: string;
  format: "heif" | "image";
  width: number;
  maxSourceBytes: number;
  maxPixels: number;
  maxHeifPixels: number;
};

const data = workerData as WorkerInput;

async function render() {
  const sourceInfo = await stat(data.source);
  if (sourceInfo.size > data.maxSourceBytes) {
    const error = new Error("The source image is too large to preview.");
    (error as Error & { code: string }).code = "SOURCE_TOO_LARGE";
    throw error;
  }

  sharp.cache(false);
  sharp.concurrency(1);
  if (data.format === "image") {
    const image = sharp(data.source, {
      limitInputPixels: data.maxPixels,
      failOn: "none",
      animated: false,
    });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp", "gif", "heif"].includes(metadata.format ?? ""))
      throw new Error("This image format cannot be previewed.");
    await image
      .rotate()
      .resize({ width: data.width, height: data.width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: data.width === 640 ? 72 : 84 })
      .toFile(data.target);
    return;
  }

  // Read only after the source-size check and inspect dimensions before libheif allocates pixels.
  const buffer = await readFile(data.source);
  const images = await decodeHeic.all({ buffer });
  if (!images.length) throw new Error("HEIF image not found");
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
    await sharp(pixels, { raw: { width: image.width, height: image.height, channels: 4 } })
      .resize({ width: data.width, height: data.width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: data.width === 640 ? 72 : 84 })
      .toFile(data.target);
  } finally {
    images.dispose?.();
  }
}

if (parentPort) {
  render().then(
    () => parentPort!.postMessage({ ok: true }),
    (error: unknown) =>
      parentPort!.postMessage({
        ok: false,
        code: (error as { code?: string }).code ?? "RENDER_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }),
  );
}
