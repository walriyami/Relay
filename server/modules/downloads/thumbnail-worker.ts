import { readFile, stat, writeFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
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

  // Reading and writing are separate from decoding so filesystem failures cannot be mistaken
  // for a deterministic invalid-image result from the decoder.
  const buffer = await readFile(data.source);
  sharp.cache(false);
  sharp.concurrency(1);
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
  // Loaded here, not up front: each thumbnail gets a fresh worker, and most images are not HEIF.
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

if (parentPort) {
  render().then(
    () => parentPort!.postMessage({ ok: true }),
    (error: unknown) =>
      parentPort!.postMessage({
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
}
