// What a preview may cost before any pixel is decoded. Every image is judged from its header: the
// memory its decoder will need has to fit well inside the server's, whatever the file's size, name
// or shape, because decoders allocate native memory that no worker limit can stop.
import type { Metadata } from "sharp";

export const MAX_SOURCE_BYTES = 50 * 1024 ** 2;
/** Pixels in any image. Within this, the limits below decide by shape, depth and format. */
export const MAX_PIXELS = 50_000_000;
/** Longest side. Wider or taller images aren't photos, and very tall ones take minutes to read row by row. */
export const MAX_SIDE = 65_535;
/**
 * One decoded row, for formats read a few rows at a time (PNG, and JPEG with one scan). Memory grows
 * with the width of a row: a 25,000,000 × 2 16-bit PNG of 389 KB needs over 1.2 GB to shrink.
 * 128 KiB is a 43,690-pixel colour panorama, or 16,384 pixels at 16 bits with transparency.
 */
export const MAX_ROW_BYTES = 128 * 1024;
/**
 * Memory a decoder that holds the whole image may use: interlaced PNG, progressive or multi-scan
 * JPEG, GIF, WebP and AVIF. The costliest allowed image adds about 340 MB while it renders,
 * leaving room in a 768 MB server for uploads and ZIPs running at the same time.
 */
export const MAX_DECODED_BYTES = 200 * 1024 ** 2;
/**
 * HEIC photos, which libheif decodes whole into WebAssembly memory before Relay copies the pixels
 * out: about 12 bytes a pixel. 25 MP covers the 24 MP photos recent iPhones take by default.
 */
export const MAX_HEIF_PIXELS = 25_000_000;
/** Scans in one JPEG. Real progressive JPEGs have about 10; each extra scan is another pass. */
export const MAX_JPEG_SCANS = 100;

/**
 * Bytes per pixel that a whole-image decoder holds at its peak, measured in a 768 MB container:
 * libwebp's RGBA output, a GIF frame plus libvips' copy of it, and AVIF's YUV planes, RGB output
 * and copies (up to 12-bit 4:4:4).
 */
const WHOLE_IMAGE_BYTES_PER_PIXEL = { webp: 4, gif: 8, heif: 24 } as const;

export type JpegLayout = {
  /** Start-of-scan markers before the end of the image. */
  scans: number;
  /**
   * Whether libjpeg holds every coefficient before producing a row: a progressive JPEG, or one whose
   * first scan doesn't carry every component. Then it is decoded whole, however few scans follow.
   */
  wholeImage: boolean;
  /** What libjpeg allocates for those coefficients. */
  coefficientBytes: number;
};

const isFrameMarker = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
/** Progressive frames, Huffman or arithmetic coded. */
const isProgressiveMarker = (marker: number) =>
  marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce;

/**
 * Walks a JPEG's markers without decoding it: the number of scans, and the size of the coefficient
 * buffer libjpeg keeps when it can't stream. Segments are skipped by their length, so an embedded
 * EXIF thumbnail isn't counted; scan data is skipped to the next marker.
 */
export function jpegLayout(data: Buffer): JpegLayout {
  let scans = 0;
  let wholeImage = false;
  let components = 0;
  let coefficientBytes = 0;
  let i = 2;
  while (i + 1 < data.length) {
    if (data[i] !== 0xff) {
      // Entropy-coded scan data.
      i = data.indexOf(0xff, i);
      if (i === -1) break;
      continue;
    }
    const marker = data[i + 1];
    // Fill bytes, stuffed zero bytes and restart markers inside scan data carry no length.
    if (marker === 0xff) i++;
    else if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) i += 2;
    else if (marker === 0xd9) break;
    else {
      if (i + 4 > data.length) break;
      const length = data.readUInt16BE(i + 2);
      if (marker === 0xda) {
        // A first scan with fewer components than the frame means the rest arrive in later scans.
        if (!scans && i + 4 < data.length && data[i + 4] < components) wholeImage = true;
        scans++;
      } else if (isFrameMarker(marker) && !components && i + 10 <= data.length) {
        if (isProgressiveMarker(marker)) wholeImage = true;
        const height = data.readUInt16BE(i + 5);
        const width = data.readUInt16BE(i + 7);
        const count = data[i + 9];
        components = count;
        const factors: { h: number; v: number }[] = [];
        for (let c = 0; c < count && i + 12 + c * 3 < data.length; c++) {
          const sampling = data[i + 11 + c * 3];
          factors.push({ h: Math.max(1, sampling >> 4), v: Math.max(1, sampling & 15) });
        }
        const hMax = Math.max(1, ...factors.map((f) => f.h));
        const vMax = Math.max(1, ...factors.map((f) => f.v));
        for (const { h, v } of factors) {
          // Blocks across and down, padded to whole MCUs as libjpeg pads them; 64 two-byte coefficients each.
          const across = Math.ceil(Math.ceil((width * h) / hMax / 8) / h) * h;
          const down = Math.ceil(Math.ceil((height * v) / vMax / 8) / v) * v;
          coefficientBytes += across * down * 128;
        }
      }
      i += 2 + length;
    }
  }
  return { scans, wholeImage: wholeImage || scans > 1, coefficientBytes };
}

/**
 * Why an image can't be previewed within these limits, or null if it can. Judged from the header
 * only: `metadata` is what sharp reads without decoding, and `jpeg` the JPEG's marker walk.
 */
export function decodeRefusal(metadata: Metadata, jpeg: JpegLayout | null): string | null {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const pixels = width * height;
  if (!width || !height) return "The image has no size.";
  if (pixels > MAX_PIXELS || Math.max(width, height) > MAX_SIDE) return "The image is too large to preview.";
  const bytesPerSample = metadata.depth === "uchar" || metadata.depth === "char" ? 1 : 2;
  const pixelBytes = (metadata.channels ?? 4) * bytesPerSample;
  switch (metadata.format) {
    case "png":
      // An interlaced PNG is decoded whole; any other is read a few rows at a time.
      if (metadata.isProgressive && pixels * pixelBytes > MAX_DECODED_BYTES)
        return "The image is too large to preview.";
      if (width * pixelBytes > MAX_ROW_BYTES) return "The image is too wide to preview.";
      return null;
    case "jpeg":
      if (!jpeg) return "The image is damaged.";
      if (jpeg.scans > MAX_JPEG_SCANS) return "The image has too many scans to preview.";
      if (jpeg.wholeImage && jpeg.coefficientBytes > MAX_DECODED_BYTES) return "The image is too large to preview.";
      if (width * pixelBytes > MAX_ROW_BYTES) return "The image is too wide to preview.";
      return null;
    case "webp":
    case "gif":
    case "heif":
      if (pixels * WHOLE_IMAGE_BYTES_PER_PIXEL[metadata.format] > MAX_DECODED_BYTES)
        return "The image is too large to preview.";
      return null;
    default:
      return "This image format cannot be previewed.";
  }
}
