// Serves a byte body made of segments (stored blob files and in-memory buffers) with single-range
// support, so one routine handles plain files, text nodes and generated ZIP archives alike.
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

export type Segment = { length: number } & ({ file: string } | { data: Buffer });
export type Body = { segments: Segment[]; length: number; etag: string };

export const bodyOf = (segments: Segment[], etag: string): Body => ({
  segments,
  etag,
  length: segments.reduce((sum, s) => sum + s.length, 0),
});

/** Only passive browser formats are served inline; active documents are shown as plain text. */
export function safePreviewMime(mime: string, name: string): string | null {
  let type = mime.split(";")[0].trim().toLowerCase();
  const aliases: Record<string, string> = {
    "audio/mp3": "audio/mpeg",
    "audio/x-m4a": "audio/mp4",
    "audio/x-wav": "audio/wav",
  };
  type = aliases[type] ?? type;
  if (!type || type === "application/octet-stream") {
    const byExtension: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      avif: "image/avif",
      bmp: "image/bmp",
      pdf: "application/pdf",
      mp4: "video/mp4",
      webm: "video/webm",
      ogv: "video/ogg",
      mov: "video/quicktime",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      ogg: "audio/ogg",
      wav: "audio/wav",
      flac: "audio/flac",
    };
    type = byExtension[name.split(".").pop()?.toLowerCase() ?? ""] ?? type;
  }
  if (
    /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|aac|ogg|wav|flac|webm)|application\/pdf)$/.test(
      type,
    )
  )
    return type;
  // HTML, SVG, scripts and XML are never rendered as active documents.
  if (type.startsWith("text/") || /^(application\/(json|.*\+json|xml|.*\+xml|javascript)|image\/svg\+xml)$/.test(type))
    return "text/plain";
  return null;
}

/** RFC 6266 / RFC 5987 filename parameter. */
export const contentDisposition = (kind: "inline" | "attachment", name: string) =>
  `${kind}; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;

const PDF_CSP = "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const SANDBOX_CSP = "sandbox; default-src 'none'; frame-ancestors 'self'";

/** Headers for an inline preview, which the app frames from its own origin. */
export function inlineHeaders(reply: FastifyReply, type: string) {
  reply
    .header("X-Frame-Options", "SAMEORIGIN")
    .header("Content-Security-Policy", type === "application/pdf" ? PDF_CSP : SANDBOX_CSP);
}

type Range = { start: number; end: number };

/** A single `bytes=` range: the range, "unsatisfiable", or null to send the whole body. */
export function parseRange(header: string | undefined, size: number): Range | "unsatisfiable" | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return "unsatisfiable";
  let start: number;
  let end = size - 1;
  if (!match[1]) start = Math.max(0, size - Number(match[2]));
  else {
    start = Number(match[1]);
    if (match[2]) end = Math.min(end, Number(match[2]));
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return "unsatisfiable";
  return { start, end };
}

/** Yields bytes start..end (inclusive) of the segments, opening each file only for its slice. */
async function* slice(segments: Segment[], start: number, end: number) {
  let offset = 0;
  for (const segment of segments) {
    const from = Math.max(start - offset, 0);
    const to = Math.min(end - offset, segment.length - 1);
    offset += segment.length;
    if (to < from) {
      if (offset > end) return;
      continue;
    }
    if ("data" in segment) yield segment.data.subarray(from, to + 1);
    else yield* createReadStream(segment.file, { start: from, end: to });
  }
}

/** Passes the bytes through, then reports how many actually left, however the stream ended. */
async function* metered(chunks: AsyncIterable<Buffer>, onSent: (bytes: number) => void) {
  let sent = 0;
  try {
    for await (const chunk of chunks) {
      yield chunk;
      sent += chunk.length;
    }
  } finally {
    if (sent) onSent(sent);
  }
}

/**
 * Sends a body with ETag, Accept-Ranges and single-range support (If-Range honoured). The caller
 * sets Content-Type and Content-Disposition first. `onSent` learns how many bytes were delivered.
 */
export function send(req: FastifyRequest, reply: FastifyReply, body: Body, onSent?: (bytes: number) => void) {
  const etag = `"${body.etag}"`;
  reply.header("ETag", etag).header("Accept-Ranges", "bytes").header("Cache-Control", "private, no-cache");
  const ifRange = req.headers["if-range"];
  const range = ifRange === undefined || ifRange === etag ? parseRange(req.headers.range, body.length) : null;
  if (range === "unsatisfiable")
    return reply.code(416).header("Content-Range", `bytes */${body.length}`).header("Content-Length", 0).send();
  const { start, end } = range ?? { start: 0, end: body.length - 1 };
  if (range) reply.code(206).header("Content-Range", `bytes ${start}-${end}/${body.length}`);
  reply.header("Content-Length", end - start + 1);
  if (req.method === "HEAD" || end < start) return reply.send();
  const chunks = slice(body.segments, start, end);
  return reply.send(Readable.from(onSent ? metered(chunks, onSent) : chunks, { objectMode: false }));
}
