// The image formats Relay previews, recognised by their first bytes. A file's name and type are
// whatever its uploader said, so only these signatures decide which decoder may see the file.
export type ImageSignature = "png" | "jpeg" | "gif" | "webp" | "heif";

/** HEIF and AVIF brands in an ISO-BMFF `ftyp` box. */
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"]);

export function imageSignature(head: Uint8Array): ImageSignature | null {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("latin1");
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(8, 12))) return "heif";
  return null;
}

/**
 * The libvips loaders the thumbnail worker leaves on. Everything else (SVG, TIFF, PDF, raw camera
 * formats and the rest) is blocked, so a file that slips past the signature check still can't
 * reach a decoder Relay never meant to run.
 */
export const ALLOWED_LOADERS = [
  "VipsForeignLoadPngBuffer",
  "VipsForeignLoadJpegBuffer",
  "VipsForeignLoadWebpBuffer",
  "VipsForeignLoadNsgifBuffer",
  "VipsForeignLoadHeifBuffer",
];
