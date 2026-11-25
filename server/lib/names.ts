import { LIMITS } from "../../shared/model.ts";
import { fileNameHides, MAX_SPACES, oneLine } from "../../shared/text.ts";
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
    /[\x00-\x1f\x7f-\x9f\u2028\u2029/\\]/.test(name) ||
    // Keep names valid UTF-8. Lone surrogates make encodeURIComponent throw and are not valid
    // filesystem or ZIP path characters.
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)
  )
    fail(400, `Choose a name without slashes, up to ${LIMITS.nameLength} characters.`);
  // A name must show what it is: direction marks could show "…exe.txt" as "…txt.exe", and hidden
  // characters or a long run of spaces could push ".exe" out of sight. Names stored earlier stay.
  if (fileNameHides(name))
    fail(400, `Choose a name without hidden characters or more than ${MAX_SPACES} spaces in a row.`);
  return name;
}

/**
 * Most names one path may have: folders inside folders, plus the file. Real folders stay far below
 * this; past it, nothing useful is lost, and SQLite cannot cascade a delete through ~1,000 levels.
 */
export const MAX_PATH_DEPTH = 64;

/** A relative "/"-separated path, split into validated segments. */
export function splitPath(value: string): string[] {
  const trimmed = value.replace(/\/+$/, "");
  if (!trimmed || trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed) || trimmed.length > 2048)
    fail(400, "Invalid file path.");
  const segments = trimmed.split("/");
  for (const segment of segments)
    if (!segment || segment !== segment.trim() || segment === "." || segment === "..") fail(400, "Invalid file path.");
  const names = segments.map(cleanName);
  if (names.length > MAX_PATH_DEPTH)
    fail(
      400,
      `Something in “${names[0]}” is nested more than ${MAX_PATH_DEPTH} levels deep, which Relay can’t store. ` +
        "Move the deepest files nearer the top and try again.",
    );
  return names;
}

/** A name someone gives themselves, as a label: one line, no control or direction characters; null when blank. */
export function cleanLabel(value: string | undefined, max: number): string | null {
  const name = oneLine(value ?? "");
  return name ? [...name].slice(0, max).join("") : null;
}
