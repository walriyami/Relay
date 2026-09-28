import { LIMITS } from "../../shared/model.ts";
import { fail } from "./errors.ts";

/** A single path segment: a file, folder or item name. */
export function cleanName(value: string): string {
  const name = value.trim().normalize("NFC");
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.length > LIMITS.nameLength ||
    Buffer.byteLength(name) > 255 ||
    // eslint-disable-next-line no-control-regex -- control characters are exactly what's refused.
    /[\x00-\x1f\x7f/\\]/.test(name) ||
    // Bidirectional controls can disguise a name (e.g. "…exe.txt" shown as "…txt.exe").
    /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name) ||
    // Keep names valid UTF-8. Lone surrogates make encodeURIComponent throw and are not valid
    // filesystem or ZIP path characters.
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)
  )
    fail(400, `Choose a name without slashes, up to ${LIMITS.nameLength} characters.`);
  return name;
}

/** A relative "/"-separated path, split into validated segments. */
export function splitPath(value: string): string[] {
  const trimmed = value.replace(/\/+$/, "");
  if (!trimmed || trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed) || trimmed.length > 2048)
    fail(400, "Invalid file path.");
  const segments = trimmed.split("/");
  for (const segment of segments)
    if (!segment || segment !== segment.trim() || segment === "." || segment === "..") fail(400, "Invalid file path.");
  return segments.map(cleanName);
}
